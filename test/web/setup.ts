import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

declare global {
  var __UI_SDK_STRICT__: boolean | undefined
}
globalThis.__UI_SDK_STRICT__ = true

// jsdom gaps that ui-sdk popups and resizable groups touch (see the ui-sdk testing guide).
HTMLElement.prototype.showPopover = function () {}
HTMLElement.prototype.hidePopover = function () {}
Element.prototype.getAnimations = () => []
Element.prototype.scrollIntoView = function () {}
Element.prototype.checkVisibility = () => true
Element.prototype.getClientRects = () => [] as unknown as DOMRectList
document.elementFromPoint = () => null
document.elementsFromPoint = () => []
window.scrollTo = () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom lays nothing out. A resizable group measures its space as the sum of its panels' widths,
// so three equal panels give the workbench a 1320px desktop-width group and pixel sizes resolve.
const measure = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function () {
  if (this.getAttribute('data-slot') !== 'resizable-panel') return measure.call(this)
  return DOMRect.fromRect({ width: 440, height: 820 })
}

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[popover] { display: block !important }',
  }),
)

afterEach(() => {
  cleanup()
  localStorage.clear()
})
