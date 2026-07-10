import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  Database, 
  ShieldCheck,
  LogOut 
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  activeTab: string;
  onNavigate: (tab: string) => void;
}

export function Sidebar({ className, activeTab, onNavigate }: SidebarProps) {
  const navItems = [
    { name: "System", id: "system", icon: LayoutDashboard },
    { name: "Users", id: "users", icon: Users },
    { name: "Config", id: "config", icon: Settings },
    { name: "Backup", id: "backup", icon: Database },
  ];

  return (
    <div className={cn("flex flex-col bg-zinc-800 h-fit space-y-4 rounded-3xl p-6", className)}>
      {/* Branding Area */}
      <div className="p-2 mb-2">
        <div className="flex items-center gap-2 px-2 border-b border-zinc-700 pb-2">
          <div className="h-8 w-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <ShieldCheck className="text-white h-5 w-5" />
          </div>
          <span className="text-xl tracking-tighter text-color-sidebar-primary-foreground">
            Ti<span className="text-primary">.</span>Soft
          </span>
        </div>
        <p className="px-2 text-[10px] font-bold text-slate-400 mt-1 tracking-widest uppercase">
          Backend Panel v1.0
        </p>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-4 space-y-1">
        {navItems.map((item) => (
          <Button
            key={item.id}
            variant={activeTab === item.id ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-11 px-4 rounded-xl transition-all",
              activeTab === item.id 
                ? "bg-slate-100 text-slate-900 font-bold shadow-sm" 
                : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
            )}
            onClick={() => onNavigate(item.id)}
          >
            <item.icon className={cn(
              "h-5 w-5",
              activeTab === item.id ? "text-indigo-600" : "text-slate-400"
            )} />
            {item.name}
          </Button>
        ))}
      </nav>

      {/* Footer Area */}
      <div className="pt-4 border-t border-slate-100">
        <Button 
          variant="ghost" 
          className="w-full justify-start gap-3 text-rose-500 hover:text-rose-600 hover:bg-rose-50 rounded-xl"
        >
          <LogOut className="h-5 w-5" />
          Terminate Session
        </Button>
      </div>
    </div>
  );
}