import {
	Storage,
	UnknownException,
	FileNotFound,
	SignedUrlOptions,
	Response,
	ExistsResponse,
	ContentResponse,
	SignedUrlResponse,
	StatResponse,
	FileListResponse,
	DeleteResponse,
	isReadableStream,
} from '@directus/drive';

import {
	BlobServiceClient,
	ContainerClient,
	StorageSharedKeyCredential,
	generateBlobSASQueryParameters,
	ContainerSASPermissions,
} from '@azure/storage-blob';

import { PassThrough, Readable } from 'stream';

function handleError(err: Error, path: string): Error {
	return new UnknownException(err, err.name, path);
}

export class AzureBlobWebServicesStorage extends Storage {
	protected $client: BlobServiceClient;
	protected $containerClient: ContainerClient;
	protected $signedCredentials: StorageSharedKeyCredential;

	constructor(config: AzureBlobWebServicesStorageConfig) {
		super();

		this.$signedCredentials = new StorageSharedKeyCredential(config.accountName, config.accountKey);
		this.$client = new BlobServiceClient(
			`https://${config.accountName}.blob.core.windows.net`,
			this.$signedCredentials
		);
		this.$containerClient = this.$client.getContainerClient(config.containerName);
	}

	public async copy(src: string, dest: string): Promise<Response> {
		try {
			const source = this.$containerClient.getBlockBlobClient(src);
			const target = this.$containerClient.getBlockBlobClient(dest);

			const poller = await target.beginCopyFromURL(source.url);
			const result = await poller.pollUntilDone();

			return { raw: result };
		} catch (e) {
			throw handleError(e, src);
		}
	}

	public async delete(location: string): Promise<DeleteResponse> {
		try {
			const result = await this.$containerClient.getBlockBlobClient(location).deleteIfExists();
			return { raw: result, wasDeleted: result.succeeded };
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public driver(): BlobServiceClient {
		return this.$client;
	}

	public async exists(location: string): Promise<ExistsResponse> {
		try {
			const result = await this.$containerClient.getBlockBlobClient(location).exists();
			return { exists: result, raw: result };
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public async get(location: string, encoding: BufferEncoding = 'utf-8'): Promise<ContentResponse<string>> {
		try {
			const bufferResult = await this.getBuffer(location);
			return {
				content: bufferResult.content.toString(encoding),
				raw: bufferResult.raw,
			};
		} catch (e) {
			throw new FileNotFound(e, location);
		}
	}

	public async getBuffer(location: string): Promise<ContentResponse<Buffer>> {
		try {
			const client = this.$containerClient.getBlobClient(location);
			return { content: await client.downloadToBuffer(), raw: client };
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public async getSignedUrl(location: string, options: SignedUrlOptions = {}): Promise<SignedUrlResponse> {
		const { expiry = 900 } = options;

		try {
			const client = this.$containerClient.getBlobClient(location);
			const blobSAS = generateBlobSASQueryParameters(
				{
					containerName: this.$containerClient.containerName,
					blobName: location,
					permissions: ContainerSASPermissions.parse('racwdl'),
					startsOn: new Date(),
					expiresOn: new Date(new Date().valueOf() + expiry),
				},
				this.$signedCredentials
			).toString();

			const sasUrl = client.url + '?' + blobSAS;
			return { signedUrl: sasUrl, raw: client };
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public async getStat(location: string): Promise<StatResponse> {
		try {
			const props = await this.$containerClient.getBlobClient(location).getProperties();
			return {
				size: props.contentLength as number,
				modified: props.lastModified as Date,
				raw: props,
			};
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public getStream(location: string): NodeJS.ReadableStream {
		const intermediateStream = new PassThrough({ highWaterMark: 1 });

		const stream = this.$containerClient.getBlobClient(location).download();

		try {
			stream
				.then((result) => result.readableStreamBody)
				.then((stream) => {
					if (!stream) {
						throw handleError(new Error('Blobclient stream was not available'), location);
					}

					stream.pipe(intermediateStream);
				})
				.catch((error) => {
					intermediateStream.emit('error', error);
				});
		} catch (error) {
			intermediateStream.emit('error', error);
		}

		return intermediateStream;
	}

	public getUrl(location: string): string {
		return this.$containerClient.getBlobClient(location).url;
	}

	public async move(src: string, dest: string): Promise<Response> {
		const source = this.$containerClient.getBlockBlobClient(src);
		const target = this.$containerClient.getBlockBlobClient(dest);

		const poller = await target.beginCopyFromURL(source.url);
		const result = await poller.pollUntilDone();

		await source.deleteIfExists();

		return { raw: result };
	}

	public async put(location: string, content: Buffer | NodeJS.ReadableStream | string): Promise<Response> {
		const blockBlobClient = this.$containerClient.getBlockBlobClient(location);
		try {
			if (isReadableStream(content)) {
				const result = await blockBlobClient.uploadStream(content as Readable);
				return { raw: result };
			}

			const result = await blockBlobClient.upload(content, content.length);
			return { raw: result };
		} catch (e) {
			throw handleError(e, location);
		}
	}

	public async *flatList(prefix = ''): AsyncIterable<FileListResponse> {
		try {
			const blobs = await this.$containerClient.listBlobsFlat();

			for await (const blob of blobs) {
				yield {
					raw: blob,
					path: blob.name as string,
				};
			}
		} catch (e) {
			throw handleError(e, prefix);
		}
	}
}

export interface AzureBlobWebServicesStorageConfig {
	containerName: string;
	accountName: string;
	accountKey: string;
}
