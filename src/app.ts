import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppConfig } from "./config/env.js";
import { MasterRepository } from "./repositories/masterRepository.js";
import { MedicationResolver } from "./services/medicationResolver.js";
import { FixtureDurClient, RepositoryDurClient, type DurClient } from "./services/durClient.js";
import {
  FixtureEasyDrugClient,
  RepositoryEasyDrugClient,
  type EasyDrugClient
} from "./services/easyDrugClient.js";
import { SafetyService } from "./services/safetyService.js";
import { ConfirmationTokenService } from "./services/confirmationToken.js";

export interface AppServices {
  repository: MasterRepository;
  resolver: MedicationResolver;
  safety: SafetyService;
  durClient: DurClient;
  easyDrugClient: EasyDrugClient;
  confirmationTokens: ConfirmationTokenService;
  baseDate: string;
  dataSha256: string;
}

export async function createAppServices(config: AppConfig): Promise<AppServices> {
  const repository = await MasterRepository.open(config.masterDbPath);
  const durClient =
    config.dataMode === "live"
      ? new RepositoryDurClient(repository, config)
      : new FixtureDurClient(config.durBaseDate);
  const easyDrugClient =
    config.dataMode === "live"
      ? new RepositoryEasyDrugClient(repository)
      : new FixtureEasyDrugClient();
  const resolver = new MedicationResolver(repository);
  const snapshotBaseDate =
    repository.metadata("fetchedAt")?.slice(0, 10) ||
    repository.metadata("baseDate") ||
    config.durBaseDate;
  const safety = new SafetyService(repository, durClient, snapshotBaseDate);
  const confirmationTokens = new ConfirmationTokenService(config.confirmationSecret);
  return {
    repository,
    resolver,
    safety,
    durClient,
    easyDrugClient,
    confirmationTokens,
    baseDate: snapshotBaseDate,
    dataSha256: createHash("sha256").update(readFileSync(config.masterDbPath)).digest("hex")
  };
}
