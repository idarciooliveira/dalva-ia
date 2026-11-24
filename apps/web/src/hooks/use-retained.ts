import { useRef } from "react";

/**
 * The last non-null `value`: a dialog fed from a row keeps showing that row
 * while it animates closed, after the row was cleared (or left the list).
 */
export function useRetained<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return last.current;
}
