"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import gsap from "gsap"
import { SplitText } from "gsap/SplitText"
import { useGSAP } from "@gsap/react"
import { cn } from "@/lib/utils"

gsap.registerPlugin(useGSAP, SplitText)

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

type MetricKey = "payroll" | "employees" | "timeOff" | "expenses"

type Metric = {
  key: MetricKey
  label: string
  format: (value: number) => string
  /** Value per timeline item (29: 7 dots, 15 bars, 7 dots). */
  values: number[]
  /** Chart score per timeline item (0–8), plotted as bar height (dots stay dots). */
  scores: number[]
  /** Week-over-week trend in %, positive = up. */
  trend: number
}

const money = (v: number) => `$${v.toFixed(1)}k`
const integer = (v: number) => `${Math.round(v)}`

// Wheel order: Payroll → Employees → Time Off → Expenses (wraps around)
const METRICS: Metric[] = [
  {
    key: "payroll",
    label: "Payroll",
    format: money,
    values: [
      11.2, 11.8, 12.4, 11.6, 12.9, 13.3, 13.8,
      14.2, 15.1, 16.8, 15.0, 13.4, 16.3, 15.2, 12.1, 14.0, 13.1, 15.3, 13.0, 14.1, 12.2, 13.0,
      12.6, 12.1, 11.7, 12.3, 11.4, 11.9, 12.2,
    ],
    scores: [
      0.4, 0.6, 0.8, 0.5, 0.9, 1.1, 1.3,
      3.9, 5.0, 7.0, 5.0, 2.8, 7.0, 5.0, 0.9, 3.9, 2.4, 5.0, 2.4, 3.9, 0.9, 3.3,
      0.8, 0.6, 0.4, 0.7, 0.3, 0.5, 0.6,
    ],
    trend: 18,
  },
  {
    key: "employees",
    label: "Employees",
    format: integer,
    values: [
      104, 106, 109, 107, 111, 113, 116,
      121, 126, 138, 127, 115, 132, 128, 109, 120, 114, 129, 113, 122, 108, 117,
      114, 112, 110, 113, 109, 111, 112,
    ],
    scores: [
      0.3, 0.5, 0.7, 0.6, 0.9, 1.0, 1.2,
      3.0, 4.6, 5.8, 6.4, 3.9, 7.6, 4.7, 2.2, 4.9, 3.1, 6.0, 3.4, 4.4, 1.6, 3.6,
      1.0, 0.8, 0.6, 0.9, 0.5, 0.7, 0.8,
    ],
    trend: 12,
  },
  {
    key: "timeOff",
    label: "Time Off",
    format: integer,
    values: [
      8, 9, 11, 10, 12, 13, 15,
      18, 20, 27, 21, 14, 24, 20, 11, 17, 14, 21, 13, 18, 10, 16,
      14, 12, 11, 13, 10, 12, 12,
    ],
    scores: [
      0.2, 0.4, 0.7, 0.5, 0.8, 1.0, 1.1,
      2.1, 3.0, 6.2, 4.8, 1.5, 5.4, 3.6, 0.7, 2.6, 4.1, 3.2, 1.8, 5.0, 2.2, 2.9,
      0.9, 0.6, 0.5, 0.8, 0.3, 0.6, 0.6,
    ],
    trend: -6,
  },
  {
    key: "expenses",
    label: "Expenses",
    format: money,
    values: [
      4.1, 4.4, 4.9, 4.6, 5.3, 5.7, 6.2,
      7.8, 8.4, 10.6, 8.5, 6.1, 9.9, 8.6, 5.0, 7.6, 6.3, 8.7, 6.0, 7.7, 4.8, 6.7,
      6.1, 5.6, 5.2, 5.8, 4.9, 5.3, 5.5,
    ],
    scores: [
      0.5, 0.6, 0.9, 0.7, 1.0, 1.2, 1.4,
      5.2, 4.1, 6.6, 3.4, 2.5, 7.2, 6.1, 2.0, 3.3, 5.0, 4.4, 3.6, 2.8, 1.2, 3.8,
      1.1, 0.9, 0.7, 1.0, 0.6, 0.8, 0.9,
    ],
    trend: 9,
  },
]

// Stats row order (matches the design, independent of wheel order)
const STAT_ORDER: MetricKey[] = ["payroll", "employees", "timeOff", "expenses"]
const metricByKey = (key: MetricKey) => METRICS.find((m) => m.key === key)!

const LEADING_DOTS = 7
const TRAILING_DOTS = 7
const ITEMS = METRICS[0].values.length // 29
const isDotItem = (item: number) => item < LEADING_DOTS || item >= ITEMS - TRAILING_DOTS

/**
 * Every timeline item maps to a wheel position. The last bar (item 21) shows
 * Payroll; each step to the left turns the wheel one notch forward.
 */
const ANCHOR_ITEM = ITEMS - TRAILING_DOTS - 1 // 21
const mod = (n: number, m: number) => ((n % m) + m) % m
const metricIndexForItem = (item: number) => mod(ANCHOR_ITEM - item, METRICS.length)

/** Nearest timeline item to `from` that maps to `metricIndex` (ties go left). */
function nearestItemForMetric(metricIndex: number, from: number) {
  let best = from
  let bestDistance = Infinity
  for (let item = 0; item < ITEMS; item++) {
    if (metricIndexForItem(item) !== metricIndex) continue
    const distance = Math.abs(item - from)
    if (distance < bestDistance) {
      best = item
      bestDistance = distance
    }
  }
  return best
}

/** Share of the viewport height the widget may use (rest = top/bottom margin). */
const VIEWPORT_FILL = 0.76
const SIDE_GUTTER = 48

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

const DOT = 18 // dot / bar width in px
const BAR_MAX = 78 // tallest bar (score 8)
const barHeight = (score: number) => Math.min(BAR_MAX, 23.8 + score * 6.74)

const BAR_ACTIVE = "#4c5ff0"
const BAR_IDLE = "#f1f1f4"

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Duration helper: 0 under prefers-reduced-motion. */
const dur = (seconds: number) => (prefersReducedMotion() ? 0 : seconds)

/** Soft top/bottom fade so rolling digits blur in and out of their slot. */
const ROLL_MASK = "linear-gradient(to bottom, transparent 0%, #000 16%, #000 84%, transparent 100%)"
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

/* ------------------------------------------------------------------ */
/* Typography: odometer-style rolling text                             */
/* ------------------------------------------------------------------ */

/**
 * Renders `text` with every digit as a vertical 0–9 strip that rolls to its
 * value. Columns are keyed from the right so units stay put when the length
 * changes; the rightmost digit moves first (odometer feel).
 */
function RollingText({ text, delay = 0, className }: { text: string; delay?: number; className?: string }) {
  const chars = Array.from(text)
  return (
    <span className={cn("relative inline-flex tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex">
        {chars.map((char, index) => {
          const fromRight = chars.length - 1 - index
          const isDigit = char >= "0" && char <= "9"
          return isDigit ? (
            <DigitRoller key={`d${fromRight}`} digit={Number(char)} delay={delay + fromRight * 0.035} />
          ) : (
            <span key={`c${fromRight}${char}`} className="inline-block">
              {char}
            </span>
          )
        })}
      </span>
    </span>
  )
}

function DigitRoller({ digit, delay }: { digit: number; delay: number }) {
  const stripRef = useRef<HTMLSpanElement>(null)
  const isFirst = useRef(true)

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    if (isFirst.current) {
      isFirst.current = false
      gsap.set(strip, { yPercent: -digit * 10 })
      return
    }
    gsap.to(strip, {
      yPercent: -digit * 10,
      duration: dur(0.9),
      delay: dur(delay),
      ease: "expo.out",
      overwrite: true,
    })
  }, [digit, delay])

  useEffect(() => {
    const strip = stripRef.current
    return () => {
      gsap.killTweensOf(strip)
    }
  }, [])

  return (
    <span className="relative inline-block h-[1lh] overflow-hidden" style={{ maskImage: ROLL_MASK, WebkitMaskImage: ROLL_MASK }}>
      <span ref={stripRef} data-digit-strip className="flex flex-col will-change-transform">
        {DIGITS.map((d) => (
          <span key={d} className="block h-[1lh] text-center">
            {d}
          </span>
        ))}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Widget                                                              */
/* ------------------------------------------------------------------ */

export function PerformanceWidget() {
  // Single source of truth: the selected timeline item. The wheel follows it.
  const [item, setItem] = useState(ANCHOR_ITEM)
  const selected = metricIndexForItem(item)

  // Zoom the whole widget out so it fits the viewport with generous margins.
  const contentRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ scale: number; width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const update = () => {
      const width = el.offsetWidth
      const height = el.offsetHeight
      const scale = Math.min(
        1,
        (window.innerHeight * VIEWPORT_FILL) / height,
        (window.innerWidth - SIDE_GUTTER) / width,
      )
      setFit({ scale, width, height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener("resize", update)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [])

  // Progressive load-in: card → title letters → trend → timeline → tooltip → stats → wheel.
  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const root = contentRef.current
      if (!root) return
      const q = gsap.utils.selector(root)

      const title = SplitText.create(q("[data-intro=title]"), { type: "words,chars", mask: "words" })

      // Pills rise in visual (top → bottom) order, not DOM order.
      const pills = (q("[data-intro=pill]") as HTMLElement[]).sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )

      const tl = gsap.timeline({ defaults: { ease: "expo.out" } })
      tl.from(q("[data-intro=card]"), { y: 48, scale: 0.94, autoAlpha: 0, duration: 1.2 }, 0)
        .from(title.chars, { yPercent: 115, duration: 1, stagger: 0.018 }, 0.18)
        .from(q("[data-intro=trend-arrow]"), { scale: 0, rotation: -120, duration: 1.1, ease: "back.out(1.8)" }, 0.4)
        .from(q("[data-intro=trend-value]"), { autoAlpha: 0, x: 10, duration: 0.8 }, 0.45)
        .from(q("[data-intro=trend-value] [data-digit-strip]"), { yPercent: 0, duration: 1.3, stagger: 0.06 }, 0.45)
        .from(q("[data-intro=dot]"), { scale: 0, autoAlpha: 0, duration: 0.7, ease: "back.out(2.2)", stagger: { each: 0.014, from: "edges" } }, 0.45)
        .from(q("[data-intro=bar-fill]"), { y: BAR_MAX - DOT, duration: 1.1, stagger: 0.024 }, 0.7)
        .from(q("[data-intro=tooltip]"), { scale: 0.4, autoAlpha: 0, duration: 0.9, ease: "back.out(2)" }, 1.15)
        .from(q("[data-intro=stat]"), { y: 18, autoAlpha: 0, duration: 1, stagger: 0.08 }, 0.85)
        .from(q("[data-intro=stat] [data-digit-strip]"), { yPercent: 0, duration: 1.4, stagger: 0.025 }, 0.85)
        .from(pills, { y: 56, scale: 0.92, autoAlpha: 0, duration: 1.1, stagger: 0.09 }, 1.05)
        .from(q("[data-intro=pill-content]"), { y: 14, autoAlpha: 0, duration: 0.9, stagger: 0.07 }, 1.25)
        .from(q("[data-intro=pill] [data-digit-strip]"), { yPercent: 0, duration: 1.3, stagger: 0.02 }, 1.25)
    },
    { scope: contentRef },
  )

  const selectItem = useCallback((next: number) => {
    setItem(Math.max(0, Math.min(ITEMS - 1, next)))
  }, [])

  const selectMetric = useCallback(
    (next: number) => {
      setItem((current) => nearestItemForMetric(mod(next, METRICS.length), current))
    },
    [],
  )

  const metric = METRICS[selected]

  return (
    <div
      className={cn("relative shrink-0", !fit && "invisible")}
      style={fit ? { width: fit.width * fit.scale, height: fit.height * fit.scale } : undefined}
    >
      <div
        ref={contentRef}
        className="absolute top-0 left-0 flex w-[885px] origin-top-left flex-col items-center"
        style={{ transform: `scale(${fit?.scale ?? 1})` }}
      >
        <PerformanceCard metric={metric} item={item} onSelectItem={selectItem} />
        <MetricWheel selected={selected} item={item} onSelect={selectMetric} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

function PerformanceCard({
  metric,
  item,
  onSelectItem,
}: {
  metric: Metric
  item: number
  onSelectItem: (item: number) => void
}) {
  const isUp = metric.trend >= 0
  const arrowRef = useRef<SVGSVGElement>(null)
  const isFirst = useRef(true)

  // Arrow flips with a springy overshoot.
  useLayoutEffect(() => {
    const arrow = arrowRef.current
    if (!arrow) return
    if (isFirst.current) {
      isFirst.current = false
      gsap.set(arrow, { rotation: isUp ? 0 : 180, transformOrigin: "50% 55%" })
      return
    }
    gsap.to(arrow, { rotation: isUp ? 0 : 180, duration: dur(0.9), ease: "back.out(1.6)", overwrite: true })
  }, [isUp])

  return (
    <section data-intro="card" className="w-full rounded-[48px] bg-white px-[55px] pt-[59px] pb-[56px] text-[#111113]">
      <header className="flex items-center justify-between">
        <h2 data-intro="title" className="text-[30px] leading-[36px] font-semibold tracking-[-0.015em]">
          Performance this week
        </h2>
        <div
          className={cn(
            "flex items-center gap-[14px] text-[30px] leading-[36px] font-semibold tracking-[-0.01em] transition-colors duration-700",
            isUp ? "text-[#4fb27f]" : "text-[#e5484d]",
          )}
          aria-label={`${isUp ? "Up" : "Down"} ${Math.abs(metric.trend)}%`}
        >
          <span data-intro="trend-arrow" className="inline-flex">
            <svg ref={arrowRef} width="26" height="22" viewBox="0 0 26 22" aria-hidden>
              <path
                d="M11.27 1.5a2 2 0 0 1 3.46 0l10.4 17.5A2 2 0 0 1 23.4 22H2.6a2 2 0 0 1-1.73-3L11.27 1.5Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span data-intro="trend-value" className="inline-flex">
            <RollingText text={`${Math.abs(metric.trend)}%`} />
          </span>
        </div>
      </header>

      <BarChart metric={metric} item={item} onSelectItem={onSelectItem} />

      <dl className="mt-[40px] grid grid-cols-4">
        {STAT_ORDER.map((key, column) => (
          <Stat key={key} metric={metricByKey(key)} item={item} column={column} />
        ))}
      </dl>
    </section>
  )
}

function Stat({ metric, item, column }: { metric: Metric; item: number; column: number }) {
  return (
    <div data-intro="stat" className="flex flex-col-reverse items-center gap-[9px]">
      <dt className="text-[23px] leading-[28px] font-normal tracking-[-0.01em] text-[#8e8e93]">{metric.label}</dt>
      <dd className="text-[27px] leading-[34px] font-semibold tracking-[-0.015em]">
        {/* Columns cascade left → right after a selection. */}
        <RollingText text={metric.format(metric.values[item])} delay={column * 0.05} />
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

function BarChart({
  metric,
  item,
  onSelectItem,
}: {
  metric: Metric
  item: number
  onSelectItem: (item: number) => void
}) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const fillRefs = useRef<(HTMLSpanElement | null)[]>([])
  const railRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const tipTiltRef = useRef<HTMLDivElement>(null)
  const prevItem = useRef(item)
  const isFirst = useRef(true)

  const heightFor = useCallback(
    (index: number) => (isDotItem(index) ? DOT : barHeight(metric.scores[index])),
    [metric],
  )

  // Bars morph height (radiating from the selection), colour follows, tooltip glides + tilts.
  useLayoutEffect(() => {
    const fills = fillRefs.current.filter((el): el is HTMLSpanElement => el !== null)
    const rail = railRef.current
    const tip = tipRef.current
    const tilt = tipTiltRef.current
    if (!rail || !tip || !tilt) return

    const railX = (item / (ITEMS - 1)) * 100
    const tipY = -(heightFor(item) + 6)

    if (isFirst.current) {
      isFirst.current = false
      fills.forEach((fill, index) => {
        gsap.set(fill, { y: BAR_MAX - heightFor(index), backgroundColor: index === item ? BAR_ACTIVE : BAR_IDLE })
      })
      gsap.set(rail, { xPercent: railX })
      gsap.set(tip, { xPercent: -50, y: tipY })
      gsap.set(tilt, { transformOrigin: "50% 100%" })
      return
    }

    const prev = prevItem.current
    prevItem.current = item
    const distance = item - prev

    gsap.to(fills, {
      y: (index: number) => BAR_MAX - heightFor(index),
      duration: dur(0.8),
      ease: "expo.out",
      stagger: { each: dur(0.016), from: item },
      overwrite: "auto",
    })

    if (prev !== item) {
      const prevFill = fillRefs.current[prev]
      const nextFill = fillRefs.current[item]
      if (prevFill) gsap.to(prevFill, { backgroundColor: BAR_IDLE, duration: dur(0.6), ease: "power2.out", overwrite: "auto" })
      if (nextFill) gsap.to(nextFill, { backgroundColor: BAR_ACTIVE, duration: dur(0.22), ease: "power2.out", overwrite: "auto" })
    }

    gsap.to(rail, { xPercent: railX, duration: dur(0.75), ease: "expo.out", overwrite: true })
    gsap.to(tip, { y: tipY, duration: dur(0.8), ease: "expo.out", overwrite: "auto" })

    // Tooltip leans against its direction of travel, then settles with a spring.
    if (distance !== 0 && !prefersReducedMotion()) {
      const lean = -Math.sign(distance) * Math.min(12, 4 + Math.abs(distance) * 1.5)
      gsap.killTweensOf(tilt)
      gsap
        .timeline()
        .to(tilt, { rotation: lean, scale: 1.06, duration: 0.16, ease: "power2.out" })
        .to(tilt, { rotation: 0, scale: 1, duration: 1, ease: "elastic.out(1, 0.45)" })
    }
  }, [item, heightFor])

  // Pointer x → nearest timeline item (works at any zoom level).
  const itemFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const rect = el.getBoundingClientRect()
    const zoom = rect.width / el.offsetWidth
    const dot = DOT * zoom
    const step = (rect.width - dot) / (ITEMS - 1)
    return Math.round((event.clientX - rect.left - dot / 2) / step)
  }

  // Click / tap selects; keep the pointer down to scrub across items.
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelectItem(itemFromPointer(event))
  }
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    onSelectItem(itemFromPointer(event))
  }

  const moveBy = (step: number) => {
    const next = Math.max(0, Math.min(ITEMS - 1, item + step))
    onSelectItem(next)
    buttonRefs.current[next]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      moveBy(-1)
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      moveBy(1)
    }
  }

  return (
    <div
      role="group"
      aria-label={`${metric.label} score per day`}
      className="relative mt-[38px] flex h-[110px] cursor-pointer touch-none items-end justify-between select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={handleKeyDown}
    >
      {Array.from({ length: ITEMS }, (_, index) => (
        <button
          key={index}
          ref={(node) => {
            buttonRefs.current[index] = node
          }}
          type="button"
          tabIndex={index === item ? 0 : -1}
          aria-label={`Day ${index + 1}: ${metric.scores[index].toFixed(1)}`}
          aria-pressed={index === item}
          onClick={() => onSelectItem(index)}
          className="group/bar flex h-full items-end rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#4c5ff0]/40 focus-visible:ring-offset-4"
        >
          {/* Rounded clip: the fill is a full-height pill slid down by transform, so both ends stay round. */}
          <span
            aria-hidden
            data-intro="dot"
            className="relative block shrink-0 overflow-hidden rounded-full"
            style={{ width: DOT, height: BAR_MAX }}
          >
            <span
              ref={(node) => {
                fillRefs.current[index] = node
              }}
              data-intro="bar-fill"
              className="absolute inset-0 rounded-full will-change-transform"
            >
              <span className="absolute inset-0 rounded-full bg-[#4c5ff0]/0 transition-colors duration-200 group-hover/bar:bg-[#4c5ff0]/10" />
            </span>
          </span>
        </button>
      ))}

      {/* Tooltip rail spans item centres; xPercent moves along it. */}
      <div className="pointer-events-none absolute inset-y-0" style={{ left: DOT / 2, right: DOT / 2 }}>
        <div ref={railRef} className="absolute inset-0 will-change-transform">
          <div ref={tipRef} className="absolute bottom-0 left-0 will-change-transform">
            <div ref={tipTiltRef} data-intro="tooltip">
              <div className="flex h-[48px] items-center rounded-[13px] bg-[#1c1c1e] px-[17px] text-[22px] leading-[30px] font-medium text-white">
                <RollingText text={metric.scores[item].toFixed(1)} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Wheel                                                               */
/* ------------------------------------------------------------------ */

const PILL_HEIGHT = 93
const PILL_WIDE = 520
const PILL_NARROW = 434
const PILL_SHIFT = (PILL_WIDE - PILL_NARROW) / 2 // 43px

/**
 * Resting Y per slot offset (-1 = above selection, 0 = selection, 1/2 = below).
 * ±0.5 beyond the ends are the fade-out points where a pill wraps around.
 */
const SLOT_STOPS: [offset: number, y: number][] = [
  [-1.5, -52],
  [-1, 0],
  [0, 115],
  [1, 235],
  [2, 348],
  [2.5, 400],
]
const WHEEL_HEIGHT = 348 + PILL_HEIGHT

/** Piecewise-linear Y for any (fractional) slot offset. */
function slotY(offset: number) {
  for (let i = 1; i < SLOT_STOPS.length; i++) {
    const [o1, y1] = SLOT_STOPS[i]
    const [o0, y0] = SLOT_STOPS[i - 1]
    if (offset <= o1) return y0 + ((offset - o0) / (o1 - o0)) * (y1 - y0)
  }
  return SLOT_STOPS[SLOT_STOPS.length - 1][1]
}

const labelColor = gsap.utils.interpolate("#b3b9e8", "#ffffff")
const valueColor = gsap.utils.interpolate("#c4c9f0", "#ffffff")
const shadowColor = gsap.utils.interpolate("rgba(0, 0, 0, 0.6)", "rgba(76, 95, 240, 0.45)")

type PillParts = {
  root: HTMLButtonElement | null
  shape: HTMLSpanElement | null
  glow: HTMLSpanElement | null
  label: HTMLSpanElement | null
  value: HTMLSpanElement | null
}

function MetricWheel({
  selected,
  item,
  onSelect,
}: {
  selected: number
  item: number
  onSelect: (index: number) => void
}) {
  const wheelRef = useRef<HTMLDivElement>(null)
  const parts = useRef<PillParts[]>(METRICS.map(() => ({ root: null, shape: null, glow: null, label: null, value: null })))
  // Continuous wheel position: pill i sits at slot offset (i - pos). Tweening
  // this one number drives every pill, so motion is seamless and interruptible.
  const wheel = useRef({ pos: selected })
  const selectedRef = useRef(selected)

  const render = useCallback(() => {
    const pos = wheel.current.pos
    parts.current.forEach((p, index) => {
      if (!p.root || !p.shape || !p.glow || !p.label || !p.value) return
      const offset = mod(index - pos + 1.5, METRICS.length) - 1.5 // [-1.5, 2.5)
      const active = Math.max(0, 1 - Math.abs(offset)) // 1 at the selection, 0 one slot away
      const presence = offset < -1 ? (offset + 1.5) / 0.5 : offset > 2 ? (2.5 - offset) / 0.5 : 1

      gsap.set(p.root, {
        y: slotY(offset),
        scale: 0.9 + 0.1 * presence,
        autoAlpha: presence,
        zIndex: offset < 0 ? 5 : Math.round(40 - offset * 10),
        pointerEvents: presence > 0.5 ? "auto" : "none",
      })
      gsap.set(p.shape, {
        width: PILL_NARROW + (PILL_WIDE - PILL_NARROW) * active,
        boxShadow: `0 ${6 + 4 * active}px ${18 + 12 * active}px ${-8 + 2 * active}px ${shadowColor(active)}`,
      })
      gsap.set(p.glow, { opacity: active })
      gsap.set(p.label, { x: (PILL_SHIFT + 4) * (1 - active), color: labelColor(active) })
      gsap.set(p.value, { x: -PILL_SHIFT * (1 - active), color: valueColor(active) })
    })
  }, [])

  // Place pills before first paint.
  useLayoutEffect(() => {
    render()
  }, [render])

  // Spin the wheel the short way round to the new selection.
  useLayoutEffect(() => {
    selectedRef.current = selected
    const state = wheel.current
    let delta = mod(selected - state.pos, METRICS.length)
    if (delta > METRICS.length / 2) delta -= METRICS.length
    if (Math.abs(delta) < 0.0001) return
    gsap.to(state, {
      pos: state.pos + delta,
      duration: dur(0.85 + Math.abs(delta) * 0.12),
      ease: "expo.out",
      overwrite: true,
      onUpdate: render,
      onComplete: render,
    })
  }, [selected, render])

  useEffect(() => {
    const state = wheel.current
    return () => {
      gsap.killTweensOf(state)
    }
  }, [])

  // Scroll to spin the wheel (throttled so one flick = one step).
  const lastWheel = useRef(0)
  useEffect(() => {
    const el = wheelRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 4) return
      event.preventDefault()
      const now = performance.now()
      if (now - lastWheel.current < 300) return
      lastWheel.current = now
      onSelect(selectedRef.current + (event.deltaY > 0 ? 1 : -1))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [onSelect])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      onSelect(selected + 1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      onSelect(selected - 1)
    }
  }

  return (
    <div
      ref={wheelRef}
      role="listbox"
      aria-label="Metric"
      aria-activedescendant={`metric-${METRICS[selected].key}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative mt-[102px] rounded-[48px] outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-8 focus-visible:ring-offset-black"
      style={{ width: PILL_WIDE, height: WHEEL_HEIGHT }}
    >
      {METRICS.map((metric, index) => (
        <button
          key={metric.key}
          id={`metric-${metric.key}`}
          ref={(node) => {
            parts.current[index].root = node
          }}
          type="button"
          role="option"
          aria-selected={index === selected}
          tabIndex={-1}
          onClick={() => onSelect(index)}
          className="absolute inset-x-0 top-0 block cursor-pointer outline-none will-change-transform"
          style={{ height: PILL_HEIGHT }}
        >
          <span data-intro="pill" className="group relative block h-full">
            {/* Shape: width morphs between narrow and wide, centred. */}
            <span
              ref={(node) => {
                parts.current[index].shape = node
              }}
              className="absolute inset-y-0 left-1/2 -translate-x-1/2 overflow-hidden rounded-full group-hover:brightness-110"
            >
              {/* Resting surface */}
              <span
                className="absolute inset-0 rounded-full"
                style={{
                  background: "linear-gradient(180deg, #4354cb 0%, #3a48b4 100%)",
                  boxShadow:
                    "inset 0 0 0 1.5px rgba(112, 128, 238, 0.55), inset 0 2px 0 rgba(168, 180, 255, 0.35), inset 0 -3px 6px rgba(18, 24, 92, 0.35)",
                }}
              />
              {/* Selected surface (opacity follows the wheel position) */}
              <span
                ref={(node) => {
                  parts.current[index].glow = node
                }}
                className="absolute inset-0 rounded-full"
                style={{
                  background: "linear-gradient(180deg, #6378f8 0%, #4e62f1 55%, #4658e4 100%)",
                  boxShadow:
                    "inset 0 0 0 2px rgba(150, 166, 255, 0.9), inset 0 3px 0 rgba(255, 255, 255, 0.28), inset 0 -3px 8px rgba(30, 40, 160, 0.3)",
                }}
              />
            </span>

            {/* Content */}
            <span data-intro="pill-content" className="relative flex h-full items-center justify-between pr-[39px] pl-[36px]">
              <span
                ref={(node) => {
                  parts.current[index].label = node
                }}
                className="text-[30px] leading-none font-normal tracking-[-0.015em]"
              >
                {metric.label}
              </span>
              <span
                ref={(node) => {
                  parts.current[index].value = node
                }}
                className="text-[32px] leading-[40px] font-semibold tracking-[-0.015em]"
              >
                {/* Values follow the card's numbers a beat later (progressive). */}
                <RollingText text={metric.format(metric.values[item])} delay={0.12} />
              </span>
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
