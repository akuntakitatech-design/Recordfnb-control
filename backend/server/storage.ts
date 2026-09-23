/**
 * storage.ts — penyimpanan lampiran.
 *
 * Driver dipilih lewat env STORAGE_DRIVER:
 *   - `r2`    : Cloudflare R2 (S3-compatible) — dipakai di produksi Coolify.
 *   - `local` : filesystem lokal (UPLOAD_DIR) — fallback dev / kompatibilitas lama.
 * Jika STORAGE_DRIVER kosong, driver `r2` dipakai otomatis bila kredensial R2 lengkap.
 *
 * Env R2: R2_ACCOUNT_ID (atau R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PREFIX (opsional)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export interface StoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

export interface StorageDriver {
  readonly name: 'r2' | 'local';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  describe(): string;
}

const uploadRoot = process.env.UPLOAD_DIR || '/data/uploads';

class LocalDriver implements StorageDriver {
  readonly name = 'local' as const;
  private resolve(key: string) {
    const absolute = path.resolve(uploadRoot, key);
    const root = path.resolve(uploadRoot) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('INVALID_ATTACHMENT_PATH');
    return absolute;
  }
  async put(key: string, data: Buffer) {
    const absolute = this.resolve(key);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data);
  }
  async get(key: string): Promise<StoredObject> {
    const absolute = this.resolve(key);
    const stat = await fs.stat(absolute);
    const handle = await fs.open(absolute, 'r');
    return { body: handle.createReadStream(), contentLength: stat.size };
  }
  async remove(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
  describe() { return `local (${uploadRoot})`; }
}

class R2Driver implements StorageDriver {
  readonly name = 'r2' as const;
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private endpoint: string;
  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID || '';
    this.endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
    this.bucket = process.env.R2_BUCKET || '';
    this.prefix = (process.env.R2_PREFIX || '').replace(/^\/+|\/+$/g, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
    });
  }
  private objectKey(key: string) {
    const clean = key.replace(/\\/g, '/').replace(/^\/+/, '');
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }
  async put(key: string, data: Buffer, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: data, ContentType: contentType }));
  }
  async get(key: string): Promise<StoredObject> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    return { body: res.Body as Readable, contentType: res.ContentType, contentLength: res.ContentLength };
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
  describe() { return `r2 (${this.endpoint}/${this.bucket}${this.prefix ? '/' + this.prefix : ''})`; }
}

function hasR2Config() {
  return Boolean((process.env.R2_ACCOUNT_ID || process.env.R2_ENDPOINT) && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

function createDriver(): StorageDriver {
  const wanted = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (wanted === 'local') return new LocalDriver();
  if (wanted === 'r2' || (!wanted && hasR2Config())) {
    if (!hasR2Config()) throw new Error('STORAGE_DRIVER=r2 tetapi env R2_* belum lengkap (R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
    return new R2Driver();
  }
  return new LocalDriver();
}

export const storage: StorageDriver = createDriver();

/** Dipanggil saat startup: log driver aktif & verifikasi akses bucket R2. */
export async function verifyStorage() {
  if (storage instanceof R2Driver) {
    await storage.check();
  }
  console.log(`[storage] attachment storage: ${storage.describe()}`);
}
