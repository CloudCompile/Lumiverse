import { beforeEach, describe, expect, mock, test } from 'bun:test'

const get = mock()
const post = mock()
const uploadRaw = mock()

mock.module('./client', () => ({
  BASE_URL: '/api/v1',
  get,
  post,
  put: mock(),
  del: mock(),
  upload: mock(),
  uploadRaw,
  uploadWithProgress: mock(),
  getBlob: mock(),
}))

mock.module('@/lib/downloads', () => ({ triggerBlobDownload: mock() }))

const { charactersApi } = await import('./characters')

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  uploadRaw.mockReset()
})

describe('charactersApi raw import jobs', () => {
  test('creates a job and uploads the original File as a raw body', async () => {
    post.mockResolvedValueOnce({ jobId: 'job-1', status: 'accepting' })
    uploadRaw.mockResolvedValueOnce({ jobId: 'job-1', status: 'accepting', uploaded: 1 })
    const file = new File(['card bytes'], 'A card #1.png', { type: 'image/png' })
    const controller = new AbortController()

    await charactersApi.createImportJob(100, true)
    await charactersApi.uploadImportJobFile('job-1', 0, file, controller.signal)

    expect(post).toHaveBeenCalledWith('/characters/import-jobs', {
      total: 100,
      skip_duplicates: true,
    })
    expect(uploadRaw).toHaveBeenCalledTimes(1)
    expect(uploadRaw.mock.calls[0]?.[0]).toBe(
      '/characters/import-jobs/job-1/files/0?filename=A%20card%20%231.png',
    )
    expect(uploadRaw.mock.calls[0]?.[1]).toBe(file)
    expect(uploadRaw.mock.calls[0]?.[2]).toEqual({
      timeout: 0,
      signal: controller.signal,
      contentType: 'image/png',
    })
  })

  test('starts, polls, and cancels through the job-specific endpoints', async () => {
    post.mockResolvedValue({ jobId: 'job/unsafe', status: 'processing' })
    get.mockResolvedValue({ jobId: 'job/unsafe', status: 'processing' })

    await charactersApi.startImportJob('job/unsafe')
    await charactersApi.getImportJob('job/unsafe')
    await charactersApi.cancelImportJob('job/unsafe')

    expect(post.mock.calls[0]?.[0]).toBe('/characters/import-jobs/job%2Funsafe/start')
    expect(get).toHaveBeenCalledWith('/characters/import-jobs/job%2Funsafe/status', undefined, undefined)
    expect(post.mock.calls[1]?.[0]).toBe('/characters/import-jobs/job%2Funsafe/cancel')
  })
})
