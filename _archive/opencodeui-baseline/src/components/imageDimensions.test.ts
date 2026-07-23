import { describe, expect, it } from 'vitest'
import { inferImageDimensions } from './imageDimensions'

describe('inferImageDimensions', () => {
  it('reads explicit image dimensions from supported URL forms', () => {
    expect(inferImageDimensions('https://picsum.photos/400/200')).toEqual({ width: 400, height: 200 })
    expect(inferImageDimensions('https://loremflickr.com/320/240')).toEqual({ width: 320, height: 240 })
    expect(inferImageDimensions('https://placekitten.com/400/200')).toEqual({ width: 400, height: 200 })
    expect(inferImageDimensions('https://example.com/preview-1280x720.png')).toEqual({ width: 1280, height: 720 })
    expect(inferImageDimensions('https://example.com/image?w=640&h=360')).toEqual({ width: 640, height: 360 })
  })

  it('prefers dimensions encoded by known image services over ignored query metadata', () => {
    expect(inferImageDimensions('https://picsum.photos/400/200?width=800&height=600')).toEqual({
      width: 400,
      height: 200,
    })
    expect(inferImageDimensions('https://dummyimage.com/600x400?width=800&height=600')).toEqual({
      width: 600,
      height: 400,
    })
  })

  it('does not treat ordinary numeric paths or date-like filenames as dimensions', () => {
    expect(inferImageDimensions('https://example.com/api/image/2024/7')).toBeNull()
    expect(inferImageDimensions('https://example.com/photo-2024x07.jpg')).toBeNull()
    expect(inferImageDimensions('https://example.com/icon-16x16.png')).toEqual({ width: 16, height: 16 })
    expect(inferImageDimensions('/archive/2024/7')).toBeNull()
  })

  it('rejects invalid or extreme dimensions', () => {
    expect(inferImageDimensions('https://picsum.photos/0/200')).toBeNull()
    expect(inferImageDimensions('https://example.com/image?w=1&h=10000')).toBeNull()
    expect(inferImageDimensions('not a url')).toBeNull()
  })
})
