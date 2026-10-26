data "digitalocean_ssh_key" "main" {
    name = var.ssh_key_name
}

resource "random_password" "jwt" {
  length = 64
  special = false
}

resource "digitalocean_droplet" "api" {
  name = "rce-api"
  image = "ubuntu-24-04-x64"
  region = var.region
  size =  var.size
  ssh_keys = [data.digitalocean_ssh_key.main.id]
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl",{
    repo_url = var.repo_url
    fqdn = var.fqdn
    jwt_secret = random_password.jwt.result
    database_url = var.database_url
  })

  lifecycle {
    ignore_changes = [ user_data ]
  }
}

resource "digitalocean_firewall" "api" {
  name = "rce-nodejs-api-fw"
  droplet_ids = [digitalocean_droplet.api.id]

  inbound_rule {
    protocol = "tcp"
    port_range = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  inbound_rule {
    protocol = "tcp"
    port_range = "80"
    source_addresses = ["0.0.0.0/0","::/0"]
  }
  inbound_rule {
    protocol = "tcp"
    port_range = "443"
    source_addresses = ["0.0.0.0/0","::/0"]
  }

  outbound_rule {
    protocol = "tcp"
    port_range = "1-65535"
    destination_addresses = ["0.0.0.0/0","::/0"]
  }
  outbound_rule {
    protocol = "udp"
    port_range = "1-65535"
    destination_addresses = ["0.0.0.0/0","::/0"]
  }

  outbound_rule {
    protocol = "icmp"
    destination_addresses = ["0.0.0.0/0","::/0"]
  }
}