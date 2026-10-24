output "alb_dns_name" {
  description = "DNS name of the load balancer."
  value       = aws_lb.app.dns_name
}

output "alb_url" {
  description = "Base URL of the API (HTTP)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (the ALB and any NAT gateways live here; also usable for Packer if there is no default VPC)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (the ASG instances live here)."
  value       = aws_subnet.private[*].id
}

output "nat_gateway_public_ips" {
  description = "Elastic IP(s) of the NAT gateway(s). Empty when NAT is disabled."
  value       = aws_eip.nat[*].public_ip
}

output "alb_security_group_id" {
  description = "Security group of the load balancer."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group of the ASG instances."
  value       = aws_security_group.app.id
}

output "ami_in_use" {
  description = "The Packer-built AMI used by the launch template (null while create_asg = false)."
  value       = local.ami_id
}

output "asg_name" {
  description = "Name of the Auto Scaling group (null while create_asg = false)."
  value       = one(aws_autoscaling_group.app[*].name)
}

output "target_group_arn" {
  description = "ARN of the target group."
  value       = aws_lb_target_group.app.arn
}

output "try_it" {
  description = "Commands to test the API once instances are healthy."
  value       = <<-EOT
    curl http://${aws_lb.app.dns_name}/
    curl http://${aws_lb.app.dns_name}/health
    curl "http://${aws_lb.app.dns_name}/load?ms=100"
  EOT
}

output "load_test_command" {
  description = "autocannon command that saturates the group and triggers scale-out."
  value       = "npx autocannon -c 40 -d 600 -t 60 \"http://${aws_lb.app.dns_name}/load?ms=100\""
}
