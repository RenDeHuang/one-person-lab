import { registerArtifactReaderAndScopeTests } from './foundry-provider-stage-run-cases/artifact-reader-and-scope.ts';
import {
  registerCoordinatorTests,
  registerTransportTests,
} from './foundry-provider-stage-run-cases/coordinator-and-transport.ts';
import {
  registerProviderContractTests,
  registerProviderManifestTests,
} from './foundry-provider-stage-run-cases/contract-and-invoker.ts';
import { registerGatewayTests } from './foundry-provider-stage-run-cases/gateway.ts';

registerProviderContractTests();
registerGatewayTests();
registerProviderManifestTests();
registerCoordinatorTests();
registerTransportTests();
registerArtifactReaderAndScopeTests();
