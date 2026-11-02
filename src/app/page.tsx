import { MissionHeader } from "@/components/mission/MissionHeader";
import { PermissionPanel } from "@/components/mission/PermissionPanel";
import { ArtifactTabs } from "@/components/mission/ArtifactTabs";
import { DeliveryCard } from "@/components/mission/DeliveryCard";
import { KpiStrip } from "@/components/mission/KpiStrip";
import { LiveTerminal } from "@/components/mission/LiveTerminal";
import { PipelineGraph } from "@/components/mission/PipelineGraph";
import { PlanPanel } from "@/components/mission/PlanPanel";
import { TicketQueue } from "@/components/mission/TicketQueue";

export default function MissionControlPage() {
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <MissionHeader />

      <PermissionPanel />

      <KpiStrip />

      <section data-ascii="surface" className="card p-4 md:p-5" aria-labelledby="pipeline-heading">
        <div className="mb-2 flex items-center justify-between">
          <p id="pipeline-heading" className="eyebrow flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden /> Pipeline de agentes
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">intake → reflect</p>
        </div>
        <PipelineGraph />
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <TicketQueue />
        </div>
        <div className="lg:col-span-5">
          <LiveTerminal />
        </div>
        <div className="lg:col-span-3">
          <PlanPanel />
        </div>
        <div className="lg:col-span-8">
          <ArtifactTabs />
        </div>
        <div className="lg:col-span-4">
          <DeliveryCard />
        </div>
      </div>
    </div>
  );
}
