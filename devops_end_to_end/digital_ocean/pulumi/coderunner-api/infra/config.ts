import * as pulumi from '@pulumi/pulumi';

const c = new pulumi.Config();

export const cfg = {
  topology: (c.get('topology') ?? 'single') as 'single' | 'autoscale',
  domain: c.require('domain'),
  subdomain: c.get('subdomain') ?? 'runner',
  region: c.get('region') ?? 'blr1',
  dropletSize: c.get('dropletSize') ?? 's-1vcpu-2gb',
  sshKeyName: c.require('sshKeyName'),
  repoUrl: c.require('repoUrl'),
  repoBranch: c.get('repoBranch') ?? 'main',
  letsencryptEmail: c.require('letsencryptEmail'),

  // Runtime images pre-pulled on every server (comma separated)
  images: (c.get('images') ?? 'node:22-alpine,python:3.13-alpine')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // App tuning, written into the server's .env
  maxConcurrentRuns: c.getNumber('maxConcurrentRuns') ?? 2,
  rateLimitPerMin: c.getNumber('rateLimitPerMin') ?? 30,

  // Phase 5
  minInstances: c.getNumber('minInstances') ?? 1,
  maxInstances: c.getNumber('maxInstances') ?? 3,
  targetCpu: c.getNumber('targetCpu') ?? 0.5,
};

export const stack = pulumi.getStack();
export const fqdn = cfg.subdomain === '@' ? cfg.domain : `${cfg.subdomain}.${cfg.domain}`;