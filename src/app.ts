import type { AppConfig } from "./config/env.js";
import { MasterRepository } from "./repositories/masterRepository.js";
import { MedicationResolver } from "./services/medicationResolver.js";
import { FixtureDurClient, LiveDurClient, type DurClient } from "./services/durClient.js";
import {
  FixtureEasyDrugClient,
  LiveEasyDrugClient,
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
}

export async function createAppServices(config: AppConfig): Promise<AppServices> {
  const repository = await MasterRepository.open(config.masterDbPath);
  const durClient =
    config.dataMode === "live"
      ? new LiveDurClient(config)
      : new FixtureDurClient(config.durBaseDate);
  const easyDrugClient =
    config.dataMode === "live" ? new LiveEasyDrugClient(config) : new FixtureEasyDrugClient();
  const resolver = new MedicationResolver(repository);
  const safety = new SafetyService(repository, durClient, config.durBaseDate);
  const confirmationTokens = new ConfirmationTokenService(config.confirmationSecret);
  return { repository, resolver, safety, durClient, easyDrugClient, confirmationTokens };
}
