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

export async function unpauseContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).unpause();
  } catch (err) {
    // Already unpaused — this call is meant to be safe to make unconditionally.
  }
}

export async function startContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).start();
  } catch (err) {
    // Already running — this call is meant to be safe to make unconditionally.
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
    if (status.paused) {
      log(`startup sweep: ${container} was paused, unpausing`);
      await unpauseContainer(docker, container);
    } else if (status.dockerStatus !== "running") {
      log(`startup sweep: ${container} was ${status.dockerStatus}, starting`);
      await startContainer(docker, container);
    }
  }
}
