output "alb_url" {
  description = "Public URL of the API (through the load balancer)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "nat_gateway_public_ip" {
  description = "The fixed public IP the instance uses to reach the internet. Add it to the MongoDB Atlas Network Access list (as x.x.x.x/32)."
  value       = aws_eip.nat.public_ip
}

output "instance_id" {
  description = "ID of the EC2 instance in the private subnet."
  value       = aws_instance.app.id
}

output "instance_private_ip" {
  description = "Private IP of the EC2 instance (it has no public IP)."
  value       = aws_instance.app.private_ip
}

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "IDs of the two public subnets (load balancer, NAT gateway)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the two private subnets (the EC2 instance is in the first one)."
  value       = aws_subnet.private[*].id
}

output "boot_log_command" {
  description = "Command that prints the instance's boot log (the output of the user data script)."
  value       = "aws ec2 get-console-output --instance-id ${aws_instance.app.id} --latest --output text --region ${var.aws_region}"
}

output "load_test_command" {
  description = "autocannon command that burns CPU on the instance through the /load endpoint."
  value       = "npx autocannon -c 10 -d 120 -t 30 \"http://${aws_lb.app.dns_name}/load?ms=100\""
}
