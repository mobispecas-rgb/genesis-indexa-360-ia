import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="top-right"
      theme="dark"
      toastOptions={{
        classNames: {
          toast: "bg-card border border-border text-foreground",
        },
      }}
    />
  );
}
