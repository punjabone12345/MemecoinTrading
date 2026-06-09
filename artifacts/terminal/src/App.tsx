import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/Shell";

import Dashboard from "@/pages/Dashboard";
import PumpfunTrader from "@/pages/PumpfunTrader";
import Positions from "@/pages/Positions";
import Analytics from "@/pages/Analytics";
import Watchlist from "@/pages/Watchlist";
import Alerts from "@/pages/Alerts";
import AutoTrader from "@/pages/AutoTrader";
import GraduationSniper from "@/pages/GraduationSniper";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/scanner" component={PumpfunTrader} />
        <Route path="/positions" component={Positions} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/watchlist" component={Watchlist} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/auto-trader" component={AutoTrader} />
        <Route path="/sniper" component={GraduationSniper} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
