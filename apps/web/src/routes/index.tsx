import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Wallet,
  ArrowLeftRight,
  PieChart,
  Target,
  TrendingDown,
  LayoutDashboard,
  Shield,
  Globe,
  Smartphone,
  Moon,
  Sun,
  LogOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDarkMode } from "@/hooks/use-dark-mode";
import { useSession, useSignOut } from "@/hooks/use-session";

export const Route = createFileRoute("/")({ component: LandingPage });

/* -------------------------------------------------------------------------- */
/*  Landing Page                                                              */
/* -------------------------------------------------------------------------- */

function LandingPage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Nav                                                                       */
/* -------------------------------------------------------------------------- */

function Nav() {
  const { isDark: dark, toggle } = useDarkMode();
  const session = useSession();
  const signOut = useSignOut();
  // A session check that failed (API down) shows the signed-out actions.
  const authState = session.isPending ? "loading" : session.data ? "authenticated" : "unauthenticated";

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-360 items-center justify-between px-3 sm:h-16 sm:px-4 lg:h-20 lg:px-20">
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <img src="/logo.svg" alt="DALVA logo" className="size-9 shrink-0 sm:size-10 lg:size-12" />
          <span className="whitespace-nowrap font-heading text-lg font-semibold text-foreground sm:text-xl lg:text-2xl">
            DALVA
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2 lg:gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="size-11 sm:size-11"
          >
            {dark ? <Sun className="size-4 sm:size-5" /> : <Moon className="size-4 sm:size-5" />}
          </Button>

          {authState === "loading" && (
            /* Skeleton placeholders while auth state loads */
            <div className="h-10 w-24 animate-pulse rounded-xl bg-muted sm:h-11 sm:w-28" />
          )}

          {authState === "unauthenticated" && (
          <>
            <Link to="/login">
              <Button variant="ghost" size="default" className="px-3 sm:px-4">
                Log in
              </Button>
            </Link>
            <Link to="/register">
              <Button variant="accent" size="default" className="px-3.5 sm:px-4 lg:px-5">
                Get Started
              </Button>
            </Link>
          </>
          )}

          {authState === "authenticated" && (
          <>
            <Link to="/dashboard">
              <Button variant="accent" size="default" className="px-3.5 sm:px-4 lg:px-5">
                Dashboard
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 sm:size-11"
              onClick={() => void signOut()}
              aria-label="Sign out"
            >
              <LogOut className="size-4 sm:size-5" />
            </Button>
          </>
          )}
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                      */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-14 sm:px-6 sm:py-20 md:py-28 lg:grid-cols-2 lg:items-center lg:gap-20 lg:px-20 lg:py-36">
        {/* Copy */}
        <div className="max-w-xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground sm:mb-4 sm:text-sm">
            Privacy-first finance
          </p>
          <h1 className="font-heading text-3xl font-semibold leading-tight tracking-tight sm:text-4xl md:text-5xl lg:text-6xl">
            Take control of{" "}
            <span className="text-wise-forest-green dark:text-wise-bright-green">
              your money
            </span>
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:mt-6 sm:text-lg md:text-xl">
            Track accounts, budgets, goals, and debts — all in one place. No
            bank integrations needed. You are the source of truth.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:flex-wrap sm:gap-4">
            <Link to="/register">
              <Button variant="accent" size="lg" className="w-full sm:w-auto">
                Get Started Free
              </Button>
            </Link>
            <a href="#features">
              <Button variant="outline" size="lg" className="w-full sm:w-auto">
                Learn More
              </Button>
            </a>
          </div>
        </div>

        {/* Decorative visual — mock dashboard cards */}
        <div className="relative hidden lg:block" aria-hidden="true">
          <div className="absolute -right-8 -top-8 h-72 w-72 rounded-full bg-wise-bright-green/20 blur-3xl" />
          <div className="absolute bottom-0 left-8 h-48 w-48 rounded-full bg-wise-bright-blue/20 blur-3xl" />

          <div className="relative mx-auto grid max-w-lg gap-5">
            {/* Net worth card */}
            <div className="rounded-3xl border border-border bg-card p-7 shadow-sm">
              <p className="text-base font-medium text-muted-foreground">
                Net Worth
              </p>
              <p className="mt-2 text-4xl font-semibold text-foreground">
                $24,850
              </p>
              <div className="mt-4 flex items-center gap-2 text-base font-medium text-wise-positive dark:text-wise-bright-green">
                <TrendingDown className="size-5 rotate-180" />
                +12.3% this month
              </div>
            </div>

            <div className="grid grid-cols-2 gap-5">
              {/* Budget card */}
              <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
                <p className="text-base font-medium text-muted-foreground">
                  Budget
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  68%
                </p>
                <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full w-[68%] rounded-full bg-wise-bright-green" />
                </div>
              </div>

              {/* Goal card */}
              <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
                <p className="text-base font-medium text-muted-foreground">
                  Vacation Goal
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  $1,200
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  of $2,000 target
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Features                                                                  */
/* -------------------------------------------------------------------------- */

const features = [
  {
    icon: Wallet,
    title: "Accounts",
    description:
      "Track cash, bank accounts, credit cards, and digital wallets — all in one place.",
    color:
      "bg-wise-bright-green/15 text-wise-forest-green dark:text-wise-bright-green",
  },
  {
    icon: ArrowLeftRight,
    title: "Transactions",
    description:
      "Record every income and expense. Filter, search, and stay on top of your money flow.",
    color:
      "bg-wise-bright-blue/20 text-wise-forest-green dark:text-wise-bright-blue",
  },
  {
    icon: PieChart,
    title: "Budgets",
    description:
      "Set monthly spending limits by category and get real-time feedback.",
    color:
      "bg-wise-bright-orange/20 text-wise-forest-green dark:text-wise-bright-orange",
  },
  {
    icon: Target,
    title: "Goals",
    description:
      "Save toward what matters. Track progress on vacations, emergency funds, and more.",
    color:
      "bg-wise-bright-yellow/20 text-wise-forest-green dark:text-wise-bright-yellow",
  },
  {
    icon: TrendingDown,
    title: "Debts",
    description:
      "Log what you owe and track every payment until you're debt-free.",
    color:
      "bg-wise-bright-pink/20 text-wise-forest-green dark:text-wise-bright-pink",
  },
  {
    icon: LayoutDashboard,
    title: "Dashboard",
    description:
      "See your net worth, cashflow, budget status, and goal progress at a glance.",
    color:
      "bg-wise-bright-green/15 text-wise-forest-green dark:text-wise-bright-green",
  },
];

function Features() {
  return (
    <section
      id="features"
      className="border-t border-border bg-secondary/40 py-14 sm:py-20 md:py-28"
    >
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
            Everything you need to manage your finances
          </h2>
          <p className="mt-3 text-base text-muted-foreground sm:mt-4 sm:text-lg">
            Six powerful modules that work DALVA to give you complete visibility
            and control.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:mt-16 sm:gap-6 sm:grid-cols-2 lg:gap-8 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-md sm:rounded-3xl sm:p-6 lg:p-7"
            >
              <div
                className={`inline-flex size-11 items-center justify-center rounded-xl sm:size-14 sm:rounded-2xl ${f.color}`}
              >
                <f.icon className="size-5 sm:size-7" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-foreground sm:mt-5 sm:text-xl">
                {f.title}
              </h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground sm:mt-3 sm:text-base">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  How It Works / Principles                                                 */
/* -------------------------------------------------------------------------- */

const principles = [
  {
    icon: Shield,
    title: "Privacy First",
    description:
      "All data belongs to you. No bank sync, no data selling, no third-party access.",
  },
  {
    icon: Smartphone,
    title: "Works Everywhere",
    description:
      "Enter transactions from any device. Your data syncs seamlessly.",
  },
  {
    icon: Globe,
    title: "Your Currency",
    description:
      "Set your preferred currency and date format. Built for global users.",
  },
];

function HowItWorks() {
  return (
    <section className="py-14 sm:py-20 md:py-28">
      <div className="mx-auto max-w-360 px-4 sm:px-6 lg:px-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
            Built on principles you can trust
          </h2>
          <p className="mt-3 text-base text-muted-foreground sm:mt-4 sm:text-lg">
            Full transparency, complete control, zero dependencies on external
            services.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:mt-16 sm:gap-8 md:grid-cols-3 md:gap-10">
          {principles.map((p) => (
            <div key={p.title} className="text-center">
              <div className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-wise-forest-green text-wise-bright-green sm:size-16 sm:rounded-3xl">
                <p.icon className="size-5 sm:size-7" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-foreground sm:mt-5 sm:text-xl">
                {p.title}
              </h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground sm:mt-3 sm:text-base">
                {p.description}
              </p>
            </div>
          ))}
        </div>

        {/* CTA band */}
        <div className="mt-10 rounded-2xl bg-wise-forest-green p-6 text-center sm:mt-16 sm:p-10 md:p-14">
          <h3 className="font-heading text-xl font-semibold text-wise-bright-green sm:text-2xl md:text-3xl">
            Ready to take control of your finances?
          </h3>
          <p className="mx-auto mt-2.5 max-w-lg text-sm leading-relaxed text-wise-bright-green/70 sm:mt-3 md:text-base">
            Start tracking your money today. It's free, private, and yours.
          </p>
          <div className="mt-6 sm:mt-8">
            <Link to="/register">
              <Button variant="accent" size="lg" className="w-full sm:w-auto">
                Get Started Free
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Footer                                                                    */
/* -------------------------------------------------------------------------- */

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-360 flex-col items-center justify-between gap-3 px-4 py-6 sm:gap-4 sm:px-6 sm:py-8 md:flex-row lg:px-20">
        <span className="font-heading text-sm font-semibold text-foreground">
          DALVA
        </span>
        <nav className="flex gap-4 text-sm text-muted-foreground sm:gap-6">
          <a href="#" className="transition-colors hover:text-foreground">
            Privacy
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            Terms
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            GitHub
          </a>
        </nav>
        <p className="text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} DALVA. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
