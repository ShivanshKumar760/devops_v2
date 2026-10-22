import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import { buildBootstrapScript } from './bootstrap.ts';
import { cfg, fqdn, stack } from './config.ts';

const anywhere = ['0.0.0.0/0', '::/0'];

export function createSingleDroplet() {
  // The SSH key already exists in your DO account. Look it up by name.
  const sshKey = digitalocean.getSshKeyOutput({ name: cfg.sshKeyName });

  // Firewalls attach to Droplets by tag.
  const tag = new digitalocean.Tag('runner-tag', { name: `code-runner-${stack}` });

  new digitalocean.Firewall('runner-fw', {
    name: `code-runner-${stack}`,
    tags: [tag.name],
    inboundRules: [
      { protocol: 'tcp', portRange: '22', sourceAddresses: anywhere },
      { protocol: 'tcp', portRange: '80', sourceAddresses: anywhere },
      { protocol: 'tcp', portRange: '443', sourceAddresses: anywhere },
    ],
    outboundRules: [
      { protocol: 'tcp', portRange: '1-65535', destinationAddresses: anywhere },
      { protocol: 'udp', portRange: '1-65535', destinationAddresses: anywhere },
      { protocol: 'icmp', destinationAddresses: anywhere },
    ],
  });

  const droplet = new digitalocean.Droplet('runner', {
    name: `code-runner-${stack}`,
    image: 'ubuntu-24-04-x64',
    region: cfg.region,
    size: cfg.dropletSize,
    sshKeys: [sshKey.id.apply(id => String(id))],
    tags: [tag.name],
    monitoring: true,
    // NOTE: changing userData forces Droplet replacement. That is the point of immutable infra.
    userData: buildBootstrapScript({
      repoUrl: cfg.repoUrl,
      branch: cfg.repoBranch,
      images: cfg.images,
      maxConcurrentRuns: cfg.maxConcurrentRuns,
      rateLimitPerMin: cfg.rateLimitPerMin,
      nginx: { domain: fqdn, email: cfg.letsencryptEmail },
    }),
  });

  return {
    dropletIp: droplet.ipv4Address,
    // What you must create at your DNS provider:
    dnsRecordToCreate: pulumi.interpolate`A  ${cfg.subdomain}  ->  ${droplet.ipv4Address}  (TTL 300)`,
    ssh: pulumi.interpolate`ssh -i ~/.ssh/digital_ocean_key root@${droplet.ipv4Address}`,
    bootstrapLog: pulumi.interpolate`ssh -i ~/.ssh/digital_ocean_key root@${droplet.ipv4Address} 'tail -f /var/log/runner-bootstrap.log'`,
  };
}