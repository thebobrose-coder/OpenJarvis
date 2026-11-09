import { ChatArea } from '../components/Chat/ChatArea';
import { ContextRail } from '../components/Chat/ContextRail';
import { useAppStore } from '../lib/store';

/** Chat, with the context rail on the right (widescreen plan 4.8). The upstream
 * System panel no longer mounts here; its telemetry lives on /ops. */
export function ChatPage() {
  const railOpen = useAppStore((s) => s.systemPanelOpen);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 min-w-0">
        <ChatArea />
      </div>
      {railOpen && <ContextRail />}
    </div>
  );
}
