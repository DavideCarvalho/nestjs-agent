import type { Experimental_DownloadFunction } from 'ai';

/**
 * A ready-made `experimental_download` for {@link import('./ai-sdk-model.js').AiSdkModelOptions}:
 * plain-fetches every URL the model can't consume natively, with NO hostname policy — unlike the
 * AI SDK's default downloader, which refuses localhost/private hostnames (SSRF guard) and kills
 * attachment parts staged against a non-public object store (local MinIO in dev, VPC-only S3).
 *
 * Safe here because the library ENFORCES that invariant rather than assuming it: `POST /agent/chat`
 * accepts only a `mediaId` and rebuilds every attachment through
 * `AttachmentStagingStore.resolve({ mediaId, actor })`, discarding whatever url the request named —
 * so the URLs reaching this downloader come exclusively from the host's own staging store. That
 * guarantee stops at this library's edge: do NOT reuse this downloader for URLs a user can
 * influence.
 *
 * Mirrors the default's routing otherwise: URLs the model supports natively are left to the
 * provider (`null`), everything else is fetched and inlined as bytes.
 */
export function attachmentFetchDownloader(
  fetchImpl: typeof fetch = fetch,
): Experimental_DownloadFunction {
  return (requests) =>
    Promise.all(
      requests.map(async ({ url, isUrlSupportedByModel }) => {
        if (isUrlSupportedByModel) {
          return null;
        }
        const response = await fetchImpl(url);
        if (!response.ok) {
          throw new Error(
            `attachmentFetchDownloader: ${response.status} fetching attachment from ${url.hostname}`,
          );
        }
        return {
          data: new Uint8Array(await response.arrayBuffer()),
          mediaType: response.headers.get('content-type') ?? undefined,
        };
      }),
    );
}
