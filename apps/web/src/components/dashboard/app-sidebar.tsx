import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  PieChart,
  Target,
  CreditCard,
  Settings,
  LogOut,
  Sun,
  Moon,
  Tags,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";

/* -------------------------------------------------------------------------- */
/*  Navigation items                                                          */
/* -------------------------------------------------------------------------- */

const mainNav = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Accounts", icon: Wallet, href: "/accounts" },
  { label: "Transactions", icon: ArrowLeftRight, href: "/transactions" },
  { label: "Categories", icon: Tags, href: "/categories" },
  { label: "Budgets", icon: PieChart, href: "/dashboard" },
  { label: "Goals", icon: Target, href: "/goals" },
  { label: "Debts", icon: CreditCard, href: "/debts" },
] as const;

const settingsNav = [
  { label: "Settings", icon: Settings, href: "/settings" },
] as const;

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

interface AppSidebarProps {
  onSignOut: () => void;
  onToggleDark: () => void;
  isDark: boolean;
  userName?: string;
}

export function AppSidebar({
  onSignOut,
  onToggleDark,
  isDark,
  userName,
}: AppSidebarProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const { isMobile, setOpenMobile } = useSidebar();

  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar>
      {/* Logo + user */}
      <SidebarHeader className="flex h-12 flex-row items-center gap-2.5 border-b border-border px-4 sm:h-14 sm:gap-3 sm:px-5">
        <Link to="/" className="flex items-center gap-2.5 sm:gap-3">
          <span className="font-heading text-base font-semibold text-sidebar-foreground sm:text-lg">
            DALVA
          </span>
          {userName && (
            <p className="max-w-30 truncate text-[11px] text-sidebar-foreground/60 sm:max-w-35 sm:text-xs">
              {userName}
            </p>
          )}
        </Link>
      </SidebarHeader>

      {/* Main navigation */}
      <SidebarContent className="px-1.5 pt-1.5 sm:px-2 sm:pt-2">
        <SidebarGroup className="p-0 pt-3 sm:pt-4">
          <SidebarGroupLabel className="px-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-sidebar-foreground/40 sm:px-3 sm:pb-2 sm:text-[11px]">
            Menu
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {mainNav.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    asChild
                    size="lg"
                    isActive={currentPath === item.href}
                    tooltip={item.label}
                    className="px-2.5 [&_svg]:size-4.5 sm:px-3 sm:[&_svg]:size-5"
                  >
                    <Link to={item.href} onClick={handleNavClick}>
                      <item.icon />
                      <span className="text-[13px] sm:text-[14px]">{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="mx-3 my-2.5 sm:mx-4 sm:my-3" />

        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="px-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-sidebar-foreground/40 sm:px-3 sm:pb-2 sm:text-[11px]">
            Settings
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {settingsNav.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    asChild
                    size="lg"
                    tooltip={item.label}
                    className="px-2.5 [&_svg]:size-4.5 sm:px-3 sm:[&_svg]:size-5"
                  >
                    <Link to={item.href} onClick={handleNavClick}>
                      <item.icon />
                      <span className="text-[13px] sm:text-[14px]">{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer: theme toggle + sign out */}
      <SidebarFooter className="px-3 pb-4 pt-2.5 sm:px-4 sm:pb-5 sm:pt-3">
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onToggleDark}
              size="lg"
              tooltip="Toggle theme"
              className="px-2.5 [&_svg]:size-4.5 sm:px-3 sm:[&_svg]:size-5"
            >
              {isDark ? <Sun /> : <Moon />}
              <span className="text-[13px] sm:text-[14px]">
                {isDark ? "Light Mode" : "Dark Mode"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onSignOut}
              size="lg"
              tooltip="Sign out"
              className="px-2.5 [&_svg]:size-4.5 sm:px-3 sm:[&_svg]:size-5"
            >
              <LogOut />
              <span className="text-[13px] sm:text-[14px]">Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
