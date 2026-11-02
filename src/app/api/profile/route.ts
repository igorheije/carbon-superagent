import { handle, ok, parseBody, requireUser } from "@/server/http";
import { updateUserProfile } from "@/server/repo/users";
import { profileSchema } from "@/server/schemas";

export const dynamic = "force-dynamic";

export function PATCH(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const patch = await parseBody(request, profileSchema);
    return ok({ user: updateUserProfile(user.id, patch) });
  });
}
