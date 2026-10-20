import * as pulumi from '@pulumi/pulumi';

const c = new pulumi.Config();

export const cfg = {
  topology: (c.get('topology') ?? 'single') as 'single' | 'autoscale',
  domain: c.require('domain'),
  subdomain: c.get('subdomain') ?? 'api',
  region: c.get('region') ?? 'blr1',
  dropletSize: c.get('dropletSize') ?? 's-1vcpu-512mb-10gb',
  sshKeyName: c.require('sshKeyName'),
  repoUrl: c.require('repoUrl'),
  repoBranch: c.get('repoBranch') ?? 'main',
  letsencryptEmail: c.require('letsencryptEmail'),
  jwtSecret: c.requireSecret('jwtSecret'),
  mongodbUri: c.requireSecret('mongodbUri'),

  // Phase 5
  minInstances: c.getNumber('minInstances') ?? 1,
  maxInstances: c.getNumber('maxInstances') ?? 3,
  targetCpu: c.getNumber('targetCpu') ?? 0.5,
  enableStress: c.getBoolean('enableStress') ?? false,
};

export const stack = pulumi.getStack();
export const fqdn = cfg.subdomain === '@' ? cfg.domain : `${cfg.subdomain}.${cfg.domain}`;