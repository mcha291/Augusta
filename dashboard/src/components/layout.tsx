import { Database, Languages, LogOut } from "lucide-react"
import { NavLink, Outlet } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useAdminAuth } from "@/lib/auth"
import { MOCK } from "@/lib/config"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { to: "/translations", label: "Translations", icon: Languages },
  { to: "/database", label: "Database", icon: Database },
]

export function Layout() {
  const auth = useAdminAuth()

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r bg-muted/30 p-4">
        <div className="mb-1 px-2 text-lg font-bold tracking-tight">Tish Admin</div>
        <div className="mb-4 px-2">
          {MOCK && <Badge variant="secondary">mock data</Badge>}
        </div>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto">
          <Separator className="my-3" />
          <div className="truncate px-2 text-xs text-muted-foreground" title={auth.email}>
            {auth.email}
          </div>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start gap-2" onClick={auth.signOut}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
