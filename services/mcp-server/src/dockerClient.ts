import type Docker from "dockerode";
import { ALLOWED_CONTAINERS, type AllowedContainer } from "./allowlist.js";

export interface ContainerStatus {
  container: AllowedContainer;
  dockerStatus: string;
  paused: boolean;
}

export async function inspectContainer(
  docker: Docker,
  container: AllowedContainer,
): Promise<ContainerStatus> {
  const info = await docker.getContainer(container).inspect();
  return {
    container,
    dockerStatus: info.State.Status,
    paused: info.State.Paused,
  };
}

function isAlreadyUnpausedError(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  const message = (err as { message?: string } | null)?.message ?? "";
  return statusCode === 500 && /not paused/i.test(message);
}

function isAlreadyStartedError(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  return statusCode === 304;
}

export async function unpauseContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).unpause();
  } catch (err) {
    if (isAlreadyUnpausedError(err)) return;
    throw err;
  }
}

export async function startContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).start();
  } catch (err) {
    if (isAlreadyStartedError(err)) return;
    throw err;
  }
}

export async function startupSweep(docker: Docker, log: (msg: string) => void): Promise<void> {
  for (const container of ALLOWED_CONTAINERS) {
    let status: ContainerStatus;
    try {
      status = await inspectContainer(docker, container);
    } catch (err) {
      log(`startup sweep: could not inspect ${container}, skipping: ${(err as Error).message}`);
      continue;
    }
    try {
      if (status.paused) {
        log(`startup sweep: ${container} was paused, unpausing`);
        await unpauseContainer(docker, container);
      } else if (status.dockerStatus !== "running") {
        log(`startup sweep: ${container} was ${status.dockerStatus}, starting`);
        await startContainer(docker, container);
      }
    } catch (err) {
      log(`startup sweep: failed to revert ${container}: ${(err as Error).message}`);
    }
  }
}
