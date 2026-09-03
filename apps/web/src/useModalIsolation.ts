import { useEffect } from 'react'

let activeModalCount = 0
let backgroundWasInert = false

/** Make the portaled dialog the only interactive document region while open. */
export function useModalIsolation(active = true) {
  useEffect(() => {
    if (!active) return
    const background = document.querySelector<HTMLElement>('.app-shell')
    if (!background) return
    if (activeModalCount === 0) {
      backgroundWasInert = background.hasAttribute('inert')
      background.setAttribute('inert', '')
    }
    activeModalCount += 1
    return () => {
      activeModalCount = Math.max(0, activeModalCount - 1)
      if (activeModalCount === 0 && !backgroundWasInert) {
        background.removeAttribute('inert')
      }
    }
  }, [active])
}
