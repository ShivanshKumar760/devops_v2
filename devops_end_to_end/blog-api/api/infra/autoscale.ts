// // infra/autoscale.ts (temporary stub, replaced in Phase 5)
// export function createAutoscale(): Record<string, string> {
//   throw new Error('autoscale topology is introduced in Phase 5');
// }
import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import { buildBootstrapScript } from './bootstrap.ts';
import {cfg,stack} from './config.ts';

const anywhere = ['0.0.0.0/0','::/0'];

export function createAutoscale(){
  const sshKey = digitalocean.getSshKeyOutput({
    name:cfg.sshKeyName
  });


  const vpc = digitalocean.getVpcOutput({ region: cfg.region });

  const tag = new digitalocean.Tag('api-tag',{name:`blog-api-${stack}`});

  const lb = new digitalocean.LoadBalancer('lb',{
    name: `blog-api-${stack}`,
    region: cfg.region,
    sizeUnit: 1,
    vpcUuid: vpc.id,
    dropletTag: tag.name,
    forwardingRules: [
      {"entryProtocol":'http',entryPort:80,targetProtocol:'http',targetPort:3000},

    ],
    healthcheck:{
      protocol:'http',
      port:3000,
      path:'/health',
      checkIntervalSeconds:10,
      responseTimeoutSeconds:5,
      unhealthyThreshold:3,
      healthyThreshold:2,
    },
  });

  new digitalocean.Firewall('api-fw',{
    name:`blog-api-${stack}`,
    tags:[tag.name],
    inboundRules:[
      {protocol:'tcp',portRange:'22',sourceAddresses:anywhere},
      {protocol:'tcp',portRange:'3000',sourceLoadBalancerUids:[lb.id]},
    ],
    outboundRules:[
      { protocol: 'tcp', portRange: '1-65535', destinationAddresses: anywhere },
      { protocol: 'udp', portRange: '1-65535', destinationAddresses: anywhere },
      { protocol: 'icmp', destinationAddresses: anywhere },
    ],
  });


  const pool = new digitalocean.DropletAutoscale('pool',{
    name:`blog-api-${stack}`,
    config:{
      minInstances:cfg.minInstances,
      maxInstances: cfg.maxInstances,
      targetCpuUtilization:cfg.targetCpu,
      cooldownMinutes:5,
    },
    dropletTemplate:{
      size:cfg.dropletSize,
      region:cfg.region,
      image:'ubuntu-24-04-x64',
      sshKeys: [sshKey.fingerprint],
      tags: [tag.id],
      vpcUuid: vpc.id,
      ipv6: false,
      withDropletAgent: true,
      userData: buildBootstrapScript({
        repoUrl:cfg.repoUrl,
        branch:cfg.repoBranch,
        jwtSecret:cfg.jwtSecret,
        mongodbUri:cfg.mongodbUri,
        enableStress:cfg.enableStress,
      }),
    },
  });


  return {
    loadBalancerIp: lb.ip,
    dnsRecordToCreate: pulumi.interpolate`A  ${cfg.subdomain}  ->  ${lb.ip}  (TTL 300)`,
    poolId: pool.id,
    watchMembers: pulumi.interpolate`doctl compute droplet-autoscale list-members ${pool.id}`,
  };
}