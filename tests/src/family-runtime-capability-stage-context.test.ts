import {
  registerDefaultExecutorAdmissionTest,
  registerProviderHostedLaunchTests,
} from './family-runtime-capability-stage-context-cases/provider-hosted.ts';
import { registerObservationTests } from './family-runtime-capability-stage-context-cases/observation.ts';
import { registerLaunchBindingTest } from './family-runtime-capability-stage-context-cases/launch-binding.ts';

registerDefaultExecutorAdmissionTest();
registerObservationTests();
registerLaunchBindingTest();
registerProviderHostedLaunchTests();
