// @vitest-environment jsdom
import type { MessageAttachment } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadAttachmentOptions } from '../backend.js';
import { AgentClient } from '../client.js';
import { storedMessageToUiMessage } from '../stored-message-to-ui-message.js';
import { acceptsFile, dragHasFiles, fileKind, filesFromClipboard, messageFiles } from './files.js';
import { useAttachments } from './use-attachments.js';

function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** An upload the test settles by hand, recording the options each call was given. */
function manualUpload() {
  const calls: Array<{
    file: File;
    options: UploadAttachmentOptions;
    resolve: (value: MessageAttachment) => void;
    reject: (error: Error) => void;
  }> = [];
  const upload = vi.fn(
    (uploaded: File, options: UploadAttachmentOptions) =>
      new Promise<MessageAttachment>((resolve, reject) => {
        calls.push({ file: uploaded, options, resolve, reject });
      }),
  );
  return { upload, calls };
}

const stored = (name: string): MessageAttachment => ({
  mediaId: `media-${name}`,
  url: `https://cdn/${name}`,
  contentType: 'image/png',
  name,
});

function dataTransfer(files: File[], types = ['Files']): DataTransfer {
  return {
    types,
    files: files as unknown as FileList,
    items: files.map((f) => ({
      kind: 'file',
      getAsFile: () => f,
    })) as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

describe('useAttachments', () => {
  it('turns away what accept, maxBytes and maxFiles refuse, and uploads the rest', async () => {
    const { upload, calls } = manualUpload();
    const { result } = renderHook(() =>
      useAttachments({ upload, accept: 'image/*,.pdf', maxBytes: 100, maxFiles: 2 }),
    );

    act(() =>
      result.current.add([
        file('a.png', 'image/png'),
        file('notes.exe', 'application/octet-stream'),
        file('huge.png', 'image/png', 500),
        file('b.pdf', 'application/pdf'),
        file('c.png', 'image/png'),
      ]),
    );

    expect(result.current.items.map((item) => [item.name, item.status])).toEqual([
      ['a.png', 'uploading'],
      ['notes.exe', 'rejected'],
      ['huge.png', 'rejected'],
      ['b.pdf', 'uploading'],
      ['c.png', 'rejected'],
    ]);
    expect(result.current.items[1]?.error).toBe('notes.exe is not a supported file type');
    expect(result.current.items[2]?.error).toBe('huge.png is too large');
    expect(result.current.items[4]?.error).toBe('Too many files');
    expect(result.current.isUploading).toBe(true);

    act(() => calls[0]?.options.onProgress?.(0.5));
    expect(result.current.items[0]?.progress).toBe(0.5);

    await act(async () => {
      calls[0]?.resolve(stored('a.png'));
      calls[1]?.resolve(stored('b.pdf'));
    });

    expect(result.current.isUploading).toBe(false);
    expect(result.current.refs).toEqual([{ mediaId: 'media-a.png' }, { mediaId: 'media-b.pdf' }]);
    expect(result.current.attachments.map((a) => a.name)).toEqual(['a.png', 'b.pdf']);
  });

  it('cancels an upload on remove, and never lets it land afterwards', async () => {
    const { upload, calls } = manualUpload();
    const { result } = renderHook(() => useAttachments({ upload }));
    act(() => result.current.add([file('a.png', 'image/png')]));
    const id = result.current.items[0]?.id ?? '';

    act(() => result.current.remove(id));
    expect(calls[0]?.options.signal?.aborted).toBe(true);
    await act(async () => calls[0]?.resolve(stored('a.png')));
    expect(result.current.items).toEqual([]);
  });

  it('marks a failed upload as an error and uploads it again on retry', async () => {
    const { upload, calls } = manualUpload();
    const { result } = renderHook(() => useAttachments({ upload }));
    act(() => result.current.add([file('a.png', 'image/png')]));
    await act(async () => calls[0]?.reject(new Error('413 too large')));
    expect(result.current.items[0]).toMatchObject({ status: 'error', error: '413 too large' });

    act(() => result.current.retry(result.current.items[0]?.id ?? ''));
    expect(result.current.items[0]?.status).toBe('uploading');
    await act(async () => calls[1]?.resolve(stored('a.png')));
    expect(result.current.items[0]?.status).toBe('ready');
  });

  it('uploads through the backend by default, and reports one that cannot', async () => {
    const uploadAttachment = vi.fn(async (f: File) => stored(f.name));
    const { result } = renderHook(() =>
      useAttachments({
        backend: { uploadAttachment } as unknown as Parameters<
          typeof useAttachments
        >[0]['backend'] &
          object,
      }),
    );
    act(() => result.current.add([file('a.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(uploadAttachment).toHaveBeenCalledTimes(1);

    const without = renderHook(() => useAttachments({}));
    act(() => without.result.current.add([file('a.png', 'image/png')]));
    expect(without.result.current.items[0]?.status).toBe('error');
  });

  it('stages pasted files and leaves a text paste alone', () => {
    const { upload } = manualUpload();
    const { result } = renderHook(() => useAttachments({ upload }));
    const textPaste = { clipboardData: dataTransfer([], ['text/plain']), preventDefault: vi.fn() };
    act(() => result.current.onPaste(textPaste));
    expect(textPaste.preventDefault).not.toHaveBeenCalled();

    const shot = {
      clipboardData: dataTransfer([file('shot.png', 'image/png')]),
      preventDefault: vi.fn(),
    };
    act(() => result.current.onPaste(shot));
    expect(shot.preventDefault).toHaveBeenCalled();
    expect(result.current.items.map((item) => item.name)).toEqual(['shot.png']);
  });

  it('tracks a file drag over the drop zone and stages the drop', () => {
    const { upload } = manualUpload();
    const { result } = renderHook(() => useAttachments({ upload }));
    const drag = (files: File[] = []) => ({
      dataTransfer: dataTransfer(files),
      preventDefault: vi.fn(),
    });

    act(() => result.current.dropZoneProps.onDragEnter(drag()));
    act(() => result.current.dropZoneProps.onDragEnter(drag()));
    act(() => result.current.dropZoneProps.onDragLeave(drag()));
    expect(result.current.isDragging).toBe(true);
    const over = drag();
    result.current.dropZoneProps.onDragOver(over);
    expect(over.preventDefault).toHaveBeenCalled();

    act(() => result.current.dropZoneProps.onDrop(drag([file('d.pdf', 'application/pdf')])));
    expect(result.current.isDragging).toBe(false);
    expect(result.current.items.map((item) => item.name)).toEqual(['d.pdf']);

    const textDrag = { dataTransfer: dataTransfer([], ['text/plain']), preventDefault: vi.fn() };
    act(() => result.current.dropZoneProps.onDragEnter(textDrag));
    expect(result.current.isDragging).toBe(false);
  });

  it('gives a file input its props and resets it after a pick', () => {
    const { upload } = manualUpload();
    const { result } = renderHook(() =>
      useAttachments({ upload, accept: ['image/*', '.pdf'], maxFiles: 1 }),
    );
    expect(result.current.inputProps).toMatchObject({
      type: 'file',
      accept: 'image/*,.pdf',
      multiple: false,
    });
    const input = { files: [file('a.png', 'image/png')], value: 'C:\\fakepath\\a.png' };
    act(() =>
      result.current.inputProps.onChange({ currentTarget: input as unknown as HTMLInputElement }),
    );
    expect(result.current.items).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('clears everything after a send', async () => {
    const { upload, calls } = manualUpload();
    const { result } = renderHook(() => useAttachments({ upload }));
    act(() => result.current.add([file('a.png', 'image/png'), file('b.png', 'image/png')]));
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(calls.every((call) => call.options.signal?.aborted)).toBe(true);
  });
});

describe('file helpers', () => {
  it('matches the <input accept> grammar', () => {
    const pdf = { name: 'Report.PDF', type: 'application/pdf' };
    expect(acceptsFile(undefined, pdf)).toBe(true);
    expect(acceptsFile('.pdf', pdf)).toBe(true);
    expect(acceptsFile(['application/*'], pdf)).toBe(true);
    expect(acceptsFile('image/*, text/csv', pdf)).toBe(false);
  });

  it('classifies media types', () => {
    expect(
      ['image/png', 'application/pdf', 'text/csv', 'audio/mpeg', 'video/mp4', 'x/y'].map(fileKind),
    ).toEqual(['image', 'pdf', 'text', 'audio', 'video', 'other']);
  });

  it('reads the files off a replayed message, stored id included', () => {
    const message = storedMessageToUiMessage({
      id: 'm1',
      role: 'user',
      content: 'see',
      createdAt: 'x',
      attachments: [
        {
          mediaId: 'md-1',
          url: 'https://cdn/r.pdf',
          contentType: 'application/pdf',
          name: 'r.pdf',
        },
      ],
    });
    expect(messageFiles(message)).toEqual([
      {
        url: 'https://cdn/r.pdf',
        mediaType: 'application/pdf',
        filename: 'r.pdf',
        kind: 'pdf',
        extension: 'pdf',
        mediaId: 'md-1',
      },
    ]);
    expect(
      messageFiles({ parts: [{ type: 'file', url: 'blob:x', mediaType: 'image/png' }] })[0],
    ).toMatchObject({ filename: null, extension: null, mediaId: null, kind: 'image' });
  });

  it('reads files from a clipboard and tells a file drag from a text one', () => {
    expect(filesFromClipboard(null)).toEqual([]);
    expect(filesFromClipboard(dataTransfer([file('x.png', 'image/png')]))).toHaveLength(1);
    expect(dragHasFiles(dataTransfer([]))).toBe(true);
    expect(dragHasFiles(dataTransfer([], ['text/uri-list']))).toBe(false);
  });
});

describe('AgentClient.uploadAttachment progress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports progress through XHR when nobody injected a fetch', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    class FakeXhr {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      status = 0;
      statusText = '';
      responseText = '';
      withCredentials = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private url = '';
      private headers: Record<string, string> = {};
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      abort() {
        this.onabort?.();
      }
      send() {
        sent.push({ url: this.url, headers: this.headers });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.status = 201;
        this.responseText = JSON.stringify(stored('a.png'));
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress: number[] = [];
    const client = new AgentClient({
      baseUrl: '/api',
      credentials: 'include',
      getHeaders: () => ({ 'X-XSRF-TOKEN': 't' }),
    });

    const attachment = await client.uploadAttachment(file('a.png', 'image/png'), {
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(attachment.mediaId).toBe('media-a.png');
    expect(progress).toEqual([0.5, 1]);
    expect(sent[0]).toMatchObject({
      url: '/api/agent/attachments',
      headers: { 'X-XSRF-TOKEN': 't' },
    });
  });

  it('reports completion on the fetch path', async () => {
    const fetch = (async () => ({
      ok: true,
      status: 201,
      statusText: 'Created',
      text: async () => JSON.stringify(stored('a.png')),
    })) as unknown as typeof globalThis.fetch;
    const progress: number[] = [];
    await new AgentClient({ fetch }).uploadAttachment(file('a.png', 'image/png'), {
      onProgress: (fraction) => progress.push(fraction),
    });
    expect(progress).toEqual([1]);
  });
});

describe('AgentClient attachments strategy', () => {
  it('routes uploadAttachment through a custom strategy, handing it the connection', async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new AgentClient({
      baseUrl: 'https://api.test/',
      fetch: fetchImpl,
      credentials: 'include',
      headers: { a: '1' },
      getHeaders: () => ({ b: '2' }),
      attachments: async (uploaded, options, connection) => {
        seen.push({
          name: uploaded.name,
          hasSignal: options.signal !== undefined,
          baseUrl: connection.baseUrl,
          credentials: connection.credentials,
          headers: await connection.headers(),
          fetch: connection.fetch,
        });
        return stored(uploaded.name);
      },
    });
    const controller = new AbortController();
    expect(
      await client.uploadAttachment(file('x.png', 'image/png'), { signal: controller.signal }),
    ).toEqual(stored('x.png'));
    expect(seen).toEqual([
      {
        name: 'x.png',
        hasSignal: true,
        baseUrl: 'https://api.test',
        credentials: 'include',
        headers: { a: '1', b: '2' },
        fetch: fetchImpl,
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
