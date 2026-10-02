import { PerformanceWidget } from "@/components/performance-widget"

export default function Home() {
  return (
    <main className="flex h-dvh w-full flex-1 items-center justify-center overflow-hidden bg-black">
      <PerformanceWidget />
    </main>
  )
}
