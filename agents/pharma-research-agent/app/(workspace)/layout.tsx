import { ReportsProvider } from "@/components/app/reports-provider";
import { Sidebar } from "@/components/app/sidebar";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <ReportsProvider>
      <div className="lg:flex">
        <Sidebar />
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </ReportsProvider>
  );
}
