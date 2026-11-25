import * as Flags from "country-flag-icons/react/3x2";
import { cn } from "@/lib/utils";

/** Country flag as inline SVG: flag emoji render as plain letters on Windows. */
export function CurrencyFlag({
  country,
  className,
}: {
  country: string;
  className?: string;
}) {
  const Flag = (Flags as Record<string, React.ComponentType<{ className?: string }>>)[country];
  if (!Flag) return null;
  return <Flag aria-hidden className={cn("h-3.5 w-5 shrink-0 rounded-[2px]", className)} />;
}
