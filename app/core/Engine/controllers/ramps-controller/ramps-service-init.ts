import { Platform } from 'react-native';
import { MessengerClientInitFunction } from '../../types';
import {
  RampsService,
  RampsServiceMessenger,
  RampsEnvironment,
} from '@metamask/ramps-controller';
import Logger from '../../../../util/Logger';

function extractFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function getRampsCacheBaseUrl(environment: RampsEnvironment): string {
  switch (environment) {
    case RampsEnvironment.Production:
      return 'https://on-ramp-cache.api.cx.metamask.io';
    case RampsEnvironment.Development:
      return 'https://on-ramp-cache.dev-api.cx.metamask.io';
    case RampsEnvironment.Local:
      return 'http://localhost';
    case RampsEnvironment.Staging:
    default:
      return 'https://on-ramp-cache.uat-api.cx.metamask.io';
  }
}

function logRampsInitUrl(message: string): void {
  Logger.log(`[RAMPS_INIT] ${message}`);
}

function createRampsServiceFetch(): typeof fetch {
  if (!__DEV__) {
    return fetch;
  }

  let hasLoggedFirstInitUrl = false;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = extractFetchUrl(input);
    if (
      !hasLoggedFirstInitUrl &&
      /on-ramp-cache\.(dev-api|uat-api|api)\.cx\.metamask\.io/u.test(url) &&
      /\/v2\/regions\/[^/]+\/(providers|topTokens|payments)(\?|$)/u.test(url)
    ) {
      hasLoggedFirstInitUrl = true;
      logRampsInitUrl(`First init API URL: ${url}`);
    }

    return fetch(input, init);
  };
}

/**
 * When BUILDS_ENABLED_WITH_GH_ACTIONS_TEMPORARY (and not E2E), uses RAMPS_ENVIRONMENT (set by builds.yml).
 * Otherwise (legacy .js.env / E2E), uses METAMASK_ENVIRONMENT switch.
 */
export function getRampsEnvironment(): RampsEnvironment {
  // Dev-only opt-in toggle to route ramps traffic to the development environment.
  if (process.env.RAMPS_USE_DEV_ENVIRONMENT === 'true') {
    return RampsEnvironment.Development;
  }

  if (process.env.BUILDS_ENABLED_WITH_GH_ACTIONS_TEMPORARY === 'true') {
    const rampsEnv = process.env.RAMPS_ENVIRONMENT;
    return rampsEnv === 'production'
      ? RampsEnvironment.Production
      : RampsEnvironment.Staging;
  }
  const metamaskEnvironment = process.env.METAMASK_ENVIRONMENT;
  switch (metamaskEnvironment) {
    case 'production':
    case 'beta':
    case 'rc':
      return RampsEnvironment.Production;
    case 'dev':
    case 'exp':
    case 'test':
    case 'e2e':
    default:
      return RampsEnvironment.Staging;
  }
}

/**
 * Gets the context for the ramps service based on the platform.
 *
 * @returns The context string (e.g., 'mobile-ios', 'mobile-android').
 */
export function getRampsContext(): string {
  return Platform.OS === 'ios' ? 'mobile-ios' : 'mobile-android';
}

/**
 * Initialize the on-ramp service.
 *
 * @param request - The request object.
 * @param request.controllerMessenger - The messenger to use for the service.
 * @returns The initialized service.
 */
export const rampsServiceInit: MessengerClientInitFunction<
  RampsService,
  RampsServiceMessenger
> = ({ controllerMessenger }) => {
  const environment = getRampsEnvironment();
  if (__DEV__) {
    logRampsInitUrl(
      `Init with RAMPS_USE_DEV_ENVIRONMENT=${process.env.RAMPS_USE_DEV_ENVIRONMENT ?? 'unset'}; resolved environment=${environment}; expected base host=${getRampsCacheBaseUrl(environment)}`,
    );
  }
  const service = new RampsService({
    messenger: controllerMessenger,
    environment,
    context: getRampsContext(),
    fetch: createRampsServiceFetch(),
  });

  return {
    controller: service,
  };
};
