terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
        source = "hashicorp/aws"
        version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge({ Project = var.project_name, ManagedBy = "terraform" }, var.tags)
  }
}

data "aws_availability_zones" "available"{
    state = "available"
}

data "aws_ami" "app" {
    count = var.create_asg ? 1 : 0
    most_recent = true 
    owners = ["self"]
    filter {
      name = "name"
      values = ["${var.ami_name_prefix}*"]
    }
    filter {
      name = "state"
      values = ["available"]
    }
}


locals {
  name = var.project_name
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # one NAT gateway, or one per AZ, or none
  nat_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : var.az_count) : 0

  ami_id = one(data.aws_ami.app[*].id)

  # Contents of the instance's .env file: three fixed settings plus everything in var.app_env
  env_file = join("\n", concat(
    ["PORT=3000", "NODE_ENV=production", "APP_NAME=${var.app_name}"],
    [for k, v in var.app_env : "${k}=${v}"]
  ))

  # Runs once, as root, on first boot of every instance. Node, PM2 and the code are already in the AMI.
  # The quoted 'EOF' stops bash from expanding $ or backticks inside secret values.
  user_data = <<-EOT
    #!/bin/bash
    set -eu
    export HOME=/root

    APP_DIR='${var.app_dir}'

    cat > "$APP_DIR/.env" <<'EOF'
    ${local.env_file}
    EOF
    chmod 600 "$APP_DIR/.env"

    cd "$APP_DIR"
    pm2 start ecosystem.config.cjs
    pm2 save
  EOT
}


resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support = true
  tags = {Name = "${local.name}-vpc"}
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags = {Name="${local.name}-igw"}
}

resource "aws_subnet" "public" {
  count = var.az_count
  vpc_id  = aws_vpc.this.id 
  availability_zone = local.azs[count.index]
  cidr_block = cidrsubnet(var.vpc_cidr,8,count.index+1)
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.name}-public-${substr(local.azs[count.index], -1, -1)}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 11)
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-private-${substr(local.azs[count.index], -1, -1)}"
    Tier = "private"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags = {Name = "${local.name}-rtb-public"}
}

resource "aws_route" "public_internet" {
  route_table_id = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id =   aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count = local.nat_count
  domain = "vpc"  
  tags       = { Name = "${local.name}-nat-eip-${count.index + 1}" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = { Name = "${local.name}-nat-${count.index + 1}" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-rtb-private-${substr(local.azs[count.index], -1, -1)}" }
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? var.az_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}


resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "Application Load Balancer: HTTP from the internet"
  vpc_id      = aws_vpc.this.id

  ingress {
    description      = "HTTP from anywhere"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb-sg" }
}

# The instances: port 3000 only from the load balancer, no SSH, no public IP
resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "ASG instances: TCP 3000 from the load balancer only"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "App port from the ALB security group"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-app-sg" }
}

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-tg"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "instance"
  deregistration_delay = 30 # seconds, so scale-in finishes sooner (default is 300)

  health_check {
    enabled             = true
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg" }
}


resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id # the ALB lives in the PUBLIC subnets

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}



resource "aws_launch_template" "app" {
  count = var.create_asg ? 1 : 0

  name                   = "${local.name}-lt"
  description            = "Simple API from the Packer-built AMI"
  image_id               = local.ami_id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.app.id]
  user_data              = base64encode(local.user_data)
  update_default_version = true

  # 1-minute CPU metrics, so scaling reacts in minutes
  monitoring {
    enabled = true
  }

  # IMDSv2 only
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-api" }
  }
}

resource "aws_autoscaling_group" "app" {
  count = var.create_asg ? 1 : 0

  name                      = "${local.name}-asg"
  min_size                  = var.min_size
  max_size                  = var.max_size
  desired_capacity          = var.desired_capacity
  vpc_zone_identifier       = aws_subnet.private[*].id # instances run in the PRIVATE subnets
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = var.health_check_grace_seconds
  default_instance_warmup   = var.health_check_grace_seconds

  launch_template {
    id      = aws_launch_template.app[0].id
    version = aws_launch_template.app[0].latest_version
  }

  # A new AMI or new user data changes the launch template, which rolls the instances automatically
  instance_refresh {
    strategy = "Rolling"

    preferences {
      min_healthy_percentage = 50
      instance_warmup        = var.health_check_grace_seconds
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.name}-api"
    propagate_at_launch = true
  }

  # The scaling policy changes the desired capacity, so do not treat that as drift
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_autoscaling_policy" "cpu" {
  count = var.create_asg ? 1 : 0

  name                      = "${local.name}-cpu-target"
  autoscaling_group_name    = aws_autoscaling_group.app[0].name
  policy_type               = "TargetTrackingScaling"
  estimated_instance_warmup = var.health_check_grace_seconds

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = var.cpu_target
  }
}