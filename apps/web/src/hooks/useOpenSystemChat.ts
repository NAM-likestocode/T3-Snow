import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { newProjectId } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  SYSTEM_CHAT_ICON,
  SYSTEM_CHAT_TITLE,
  SYSTEM_CHAT_WORKSPACE_ROOT,
  isSystemChatWorkspaceRoot,
} from "~/systemChat";

import { useHandleNewThread } from "./useHandleNewThread";

function reportFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't open System chat",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Opens a new thread in the System chat of a machine (the primary one by
 * default), creating that machine's System project the first time.
 */
export function useOpenSystemChat() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const openingRef = useRef(false);

  return useCallback(
    async (targetEnvironmentId?: EnvironmentId) => {
      if (openingRef.current) return;
      const connected = environments.filter(
        (environment) =>
          environment.connection.phase === "connected" && environment.serverConfig !== null,
      );
      const environmentId =
        targetEnvironmentId ??
        connected.find((environment) => environment.environmentId === primaryEnvironmentId)
          ?.environmentId ??
        connected[0]?.environmentId;
      if (!environmentId) {
        reportFailure(new Error("Connect to a machine first."));
        return;
      }

      openingRef.current = true;
      try {
        const existing = projects.find(
          (project) =>
            project.environmentId === environmentId &&
            isSystemChatWorkspaceRoot(project.workspaceRoot),
        );
        let projectId = existing?.id;
        if (!projectId) {
          projectId = newProjectId();
          const created = await createProject({
            environmentId,
            input: {
              projectId,
              title: SYSTEM_CHAT_TITLE,
              workspaceRoot: SYSTEM_CHAT_WORKSPACE_ROOT,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: null,
            },
          });
          if (created._tag === "Failure") {
            if (!isAtomCommandInterrupted(created))
              reportFailure(squashAtomCommandFailure(created));
            return;
          }
          // Cosmetic: a failed icon update still leaves a working chat.
          await updateProject({
            environmentId,
            input: { projectId, projectIcon: SYSTEM_CHAT_ICON },
          });
        }

        const navigation = await settlePromise(() =>
          handleNewThread(scopeProjectRef(environmentId, projectId)),
        );
        if (navigation._tag === "Failure") reportFailure(squashAtomCommandFailure(navigation));
      } finally {
        openingRef.current = false;
      }
    },
    [createProject, environments, handleNewThread, primaryEnvironmentId, projects, updateProject],
  );
}
