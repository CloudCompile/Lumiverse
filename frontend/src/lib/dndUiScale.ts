import { CSS, type Transform } from '@dnd-kit/utilities'
import { DndContext as BaseDndContext, getClientRect, type DndContextProps } from '@dnd-kit/core'
import { createElement, useCallback, useEffect, useRef } from 'react'
import { getUiScale } from './uiScale'

const computedTransformIncludesZoom = new WeakMap<Document, boolean>()

function transformTranslationScale(element: HTMLElement, uiScale: number): number {
  const doc = element.ownerDocument
  let includesZoom = computedTransformIncludesZoom.get(doc)
  if (includesZoom === undefined) {
    // Firefox currently serializes zoomed matrix translations; Chromium and
    // WebKit serialize layout pixels. Feature-detect once, outside body so
    // the user's current scale does not influence this fixed 2x probe.
    const probe = doc.createElement('div')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:1px;height:1px;zoom:2;transform:translateX(1px)'
    doc.documentElement.appendChild(probe)
    try {
      includesZoom = new DOMMatrixReadOnly(getComputedStyle(probe).transform).m41 > 1.5
      computedTransformIncludesZoom.set(doc, includesZoom)
    } finally {
      probe.remove()
    }
  }
  const nativeZoom = includesZoom ? Number.parseFloat(getComputedStyle(doc.body).zoom) || 1 : 1
  return uiScale / nativeZoom
}

/** dnd-kit's default inverse transform mixes rendered rects with layout lengths. */
export function measureUiScaledRect(element: HTMLElement) {
  const scale = getUiScale()
  if (scale === 1) return getClientRect(element, { ignoreTransform: true })

  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  if (!style.transform || style.transform === 'none') {
    const { left, top, width, height, right, bottom } = rect
    return { left, top, width, height, right, bottom }
  }

  const matrix = new DOMMatrixReadOnly(style.transform)
  const [originX, originY] = style.transformOrigin.split(' ').map(Number.parseFloat)
  // Normalize matrix translations before removing the element's transform.
  // The origin remains in layout pixels in all engines. Body transforms on
  // Linux also need this conversion even though native CSS zoom is 1.
  const translationScale = transformTranslationScale(element, scale)
  const left = rect.left - matrix.m41 * translationScale - (1 - matrix.m11) * originX * scale
  const top = rect.top - matrix.m42 * translationScale - (1 - matrix.m22) * originY * scale
  const width = matrix.m11 ? rect.width / matrix.m11 : rect.width
  const height = matrix.m22 ? rect.height / matrix.m22 : rect.height
  return { left, top, width, height, right: left + width, bottom: top + height }
}

const scaledMeasuring = {
  draggable: { measure: measureUiScaledRect },
  droppable: { measure: measureUiScaledRect },
}

/** Use with useScaledSortableStyle so measurement and painting share units. */
export function DndContext({ measuring, ...props }: DndContextProps) {
  return createElement(BaseDndContext, {
    ...props,
    measuring: measuring ? {
      ...measuring,
      draggable: { ...scaledMeasuring.draggable, ...measuring.draggable },
      droppable: { ...scaledMeasuring.droppable, ...measuring.droppable },
    } : scaledMeasuring,
  })
}

/**
 * Walk up from `node` to the nearest scrollable ancestor (the element that
 * auto-scrolls while a drag drags past the viewport edge). Returns null if the
 * node is not inside a scroll container.
 */
function getScrollableAncestor(node: Element | null): Element | null {
  let el = node?.parentElement ?? null
  while (el) {
    const { overflowY, overflowX } = getComputedStyle(el)
    const scrollableY = /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight
    const scrollableX = /(auto|scroll|overlay)/.test(overflowX) && el.scrollWidth > el.clientWidth
    if (scrollableY || scrollableX) return el
    el = el.parentElement
  }
  return null
}

/**
 * Build a `translate3d` string from a `useSortable` transform, compensating for
 * the CSS `zoom: var(--lumiverse-ui-scale)` applied to body (see
 * theme/reset.css).
 *
 * dnd-kit's transform is the sum of two components measured in *different*
 * coordinate spaces under CSS `zoom`:
 *   - the pointer/rect delta, read from pointer events and getBoundingClientRect,
 *     which are viewport-relative and therefore in post-zoom (rendered) pixels;
 *   - the auto-scroll delta, read from `element.scrollTop`/`scrollLeft`, which is
 *     element-relative and therefore in pre-zoom (layout) pixels.
 *
 * A CSS transform on a zoomed element is itself applied in layout space (the
 * zoom multiplies it on paint), so only the pointer component must be divided by
 * the scale — the scroll component is already in layout pixels. Dividing the
 * whole sum (the previous behaviour) under-applied the scroll component by a
 * factor of the scale, so the card drifted further from the cursor the more the
 * list auto-scrolled. We subtract the scroll delta, scale the pointer remainder,
 * then add the scroll delta back untouched.
 */
function scaledTransform(
  transform: Transform | null,
  scrollDx: number,
  scrollDy: number,
  isDragging: boolean,
): string | undefined {
  if (!transform) return CSS.Transform.toString(transform)
  const uiScale = getUiScale()
  // During drag, the FLIP animation transform may include scaleX/scaleY
  // from useDerivedTransform. These scale factors compound with the pointer
  // delta and cause the card to visually stretch or squish. Strip them —
  // only keep the translation.
  if (isDragging) {
    return CSS.Transform.toString({
      x: uiScale !== 1 ? (transform.x - scrollDx) / uiScale + scrollDx : transform.x,
      y: uiScale !== 1 ? (transform.y - scrollDy) / uiScale + scrollDy : transform.y,
      scaleX: 1,
      scaleY: 1,
    })
  }
  return CSS.Transform.toString({
    ...transform,
    x: (transform.x - scrollDx) / uiScale + scrollDx,
    y: (transform.y - scrollDy) / uiScale + scrollDy,
  })
}

interface ScaledSortableArgs {
  setNodeRef: (element: HTMLElement | null) => void
  transform: Transform | null
  transition?: string
  isDragging: boolean
}

/**
 * Wraps a `useSortable` result so the dragged row tracks the cursor correctly
 * regardless of UI scale or how far the list auto-scrolls. Returns a node ref to
 * spread onto the sortable element and the `style` (transform + transition).
 *
 * Falls back to the plain scaled transform when the row is not inside a scroll
 * container or scroll detection fails, so it can never behave worse than a naive
 * scale division.
 */
export function useScaledSortableStyle({
  setNodeRef,
  transform,
  transition,
  isDragging,
}: ScaledSortableArgs): {
  setNodeRef: (element: HTMLElement | null) => void
  style: { transform: string | undefined; transition: string | undefined }
} {
  const nodeRef = useRef<HTMLElement | null>(null)
  // Scroll container + its scroll offsets captured at drag start.
  const scrollStart = useRef<{ el: Element | null; top: number; left: number } | null>(null)

  const ref = useCallback(
    (element: HTMLElement | null) => {
      nodeRef.current = element
      setNodeRef(element)
    },
    [setNodeRef],
  )

  useEffect(() => {
    if (isDragging) {
      const el = getScrollableAncestor(nodeRef.current)
      scrollStart.current = { el, top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 }
    } else {
      scrollStart.current = null
    }
  }, [isDragging])

  let scrollDx = 0
  let scrollDy = 0
  const start = scrollStart.current
  if (isDragging && start?.el) {
    scrollDx = start.el.scrollLeft - start.left
    scrollDy = start.el.scrollTop - start.top
  }

  return {
    setNodeRef: ref,
    style: {
      transform: scaledTransform(transform, scrollDx, scrollDy, isDragging),
      transition,
    },
  }
}
