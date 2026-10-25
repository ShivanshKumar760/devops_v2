output "droplet_ip" {
  value = digitalocean_droplet.api.ipv4_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/digital_ocean_key root@${digitalocean_droplet.api.ipv4_address}"
}

output "certbot_command" {
  value = "certbot --nginx -d ${var.fqdn}"
}

output "api_url" {
  value = "https://${var.fqdn}"
}
