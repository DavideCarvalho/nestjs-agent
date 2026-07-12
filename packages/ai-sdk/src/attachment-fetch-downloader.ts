import type { Experimental_DownloadFunction } from 'ai';

/**
 * A ready-made `experimental_download` for {@link import('./ai-sdk-model.js').AiSdkModelOptions}:
 * plain-fetches every URL the model can't consume natively, with NO hostname policy — unlike the
 * AI SDK's default downloader, which refuses localhost/private hostnames (SSRF guard) and kills
 * attachment parts staged against a non-public object store (local MinIO in dev, VPC-only S3).
 *
 * Only safe because agent attachment URLs come exclusively from the host's own
 * `AGENT_ATTACHMENT_STAGING` presigner — never from user input. Do NOT reuse this for URLs a user
 * can influence.
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
