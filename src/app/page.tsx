import { MissionHeader } from "@/components/mission/MissionHeader";
import { PermissionPanel } from "@/components/mission/PermissionPanel";
import { ArtifactTabs } from "@/components/mission/ArtifactTabs";
import { DeliveryCard } from "@/components/mission/DeliveryCard";
import { KpiStrip } from "@/components/mission/KpiStrip";
import { LiveTerminal } from "@/components/mission/LiveTerminal";
import { PipelineSection } from "@/components/mission/PipelineSection";
import { PlanPanel } from "@/components/mission/PlanPanel";
import { QuestionPanel } from "@/components/mission/QuestionPanel";
import { TicketQueue } from "@/components/mission/TicketQueue";

export default function MissionControlPage() {
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <MissionHeader />

      <QuestionPanel />

      <PermissionPanel />

      <KpiStrip />

      <PipelineSection />

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
