export interface BackdropEntry<T> { id: number; src: T; live?: boolean; base?: boolean }

export function pushBackdrop<T>(stack: BackdropEntry<T>[], e: BackdropEntry<T>) {
  const rest = stack.filter(x => x.id !== e.id)
  return e.base ? [e, ...rest] : [...rest, e]
}

export function popBackdrop<T>(stack: BackdropEntry<T>[], id: number) {
  return stack.filter(x => x.id !== id)
}
