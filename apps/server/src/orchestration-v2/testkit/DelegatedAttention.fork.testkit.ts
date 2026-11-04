import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "../DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
export const modelSelection = { instanceId, model: "test-model" };
const database = SqlitePersistence.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "fork-delegated-attention" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("No provider process is used by this fixture"),
    },
  ]),
  { databaseLayer: database, runEffectWorker: false },
);
export const attentionTestLayer = DelegatedTaskQuestionReactor.layer.pipe(
  Layer.provideMerge(
    ThreadManagementService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          runtime,
          ProjectionStore.layer.pipe(Layer.provide(database)),
          EffectOutbox.layer.pipe(Layer.provide(database)),
          CommandReceiptStore.layer.pipe(Layer.provide(database)),
          ServerSettings.layerTest(),
        ),
      ),
    ),
  ),
);
