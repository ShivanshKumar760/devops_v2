import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import { buildBootstrapScript } from './bootstrap.ts';
import { cfg,fqdn,stack } from './config.ts';


const anywhere = ['0.0.0.0/0', '::/0'];

export function createSingleDroplet(){
    const sshKey = digitalocean.getSshKeyOutput({name:cfg.sshKeyName});

    const tag = new digitalocean.Tag('api-tag',{name:`blog-api-${stack}`});
    new digitalocean.Firewall('api-fw',{
        name: `blog-api-${stack}`,
        tags:[tag.name],
        inboundRules:[
            {protocol:'tcp',portRange:'22',sourceAddresses:anywhere},
            {protocol:'tcp',portRange:'80',sourceAddresses:anywhere},
            {protocol:'tcp',portRange:'443',sourceAddresses:anywhere},
        ],
        outboundRules: [
            { protocol: 'tcp', portRange: '1-65535', destinationAddresses: anywhere },
            { protocol: 'udp', portRange: '1-65535', destinationAddresses: anywhere },
            { protocol: 'icmp', destinationAddresses: anywhere },
        ],
    });

    const droplet = new digitalocean.Droplet('api',{
        name : `blog-api-${stack}`,
        image: 'ubuntu-24-04-x64',
        region: cfg.region,
        size: cfg.dropletSize,
        sshKeys: [sshKey.id.apply(id => String(id))],
        tags:[tag.name],
        monitoring:true,
        userData: buildBootstrapScript({
            repoUrl: cfg.repoUrl,
            branch: cfg.repoBranch,
            jwtSecret: cfg.jwtSecret,
            mongodbUri: cfg.mongodbUri,
            enableStress: cfg.enableStress,
            nginx: { domain: fqdn, email: cfg.letsencryptEmail },
        }),

    });

    return {
        dropletIp:droplet.ipv4Address,
        dnsRecordToCreate:pulumi.interpolate`A   ${cfg.subdomain}  ->  ${droplet.ipv4Address}  (TTL 300)`,
        ssh:pulumi.interpolate`ssh -i ~/.ssh/digital_ocean_key root@${droplet.ipv4Address}`,
        bootstrapLog: pulumi.interpolate`ssh -i ~/.ssh/digital_ocean_key root@${droplet.ipv4Address} 'tail -f /var/log/blog-bootstrap.log'`,
    };
}