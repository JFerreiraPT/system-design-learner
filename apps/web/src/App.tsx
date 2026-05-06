import { NavLink, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { TutorPage } from "./pages/TutorPage";
import { useTheme } from "./lib/useTheme";

export function App() {
  return (
    <div className="app-shell">
      <header className="glass-header">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="brand-mark">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 7h16" />
                <path d="M4 12h10" />
                <path d="M4 17h7" />
                <circle cx="18" cy="14" r="3" />
              </svg>
            </div>
            <div className="leading-tight">
              <h1 className="text-[15px] font-semibold tracking-tight text-fg">
                System Design <span className="text-gradient">Learner</span>
              </h1>
              <p className="text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                Practice · Validate · Improve
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-1.5">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "btn-primary !px-3.5 !py-2" : "btn-ghost"
              }
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/tutor"
              className={({ isActive }) =>
                isActive ? "btn-primary !px-3.5 !py-2" : "btn-ghost"
              }
            >
              Concept tutor
            </NavLink>
            <span className="mx-1 h-6 w-px bg-current/10" aria-hidden />
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/problems/:id" element={<WorkspacePage />} />
        <Route path="/tutor" element={<TutorPage />} />
      </Routes>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label =
    theme === "dark"
      ? "Cycle theme: dark (next: light)"
      : theme === "light"
        ? "Cycle theme: light (next: summer)"
        : "Cycle theme: summer (next: dark)";
  return (
    <button type="button" onClick={toggle} className="btn-icon" aria-label={label} title={label}>
      <span className="relative grid h-4 w-4 place-items-center">
        <SunIcon
          className={`absolute transition ${theme === "light" ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 rotate-90"}`}
        />
        <MoonIcon
          className={`absolute transition ${theme === "dark" ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 -rotate-90"}`}
        />
        <SummerIcon
          className={`absolute transition ${theme === "summer" ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 rotate-90"}`}
        />
      </span>
    </button>
  );
}

function SunIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Sun over horizon — summer cycle step */
function SummerIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-amber-600 ${className}`}
    >
      <path d="M12 2v2" />
      <path d="M12 16v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <circle cx="12" cy="10" r="4" />
      <path d="M3 20h18" />
    </svg>
  );
}
