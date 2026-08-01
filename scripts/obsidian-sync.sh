#!/bin/bash
# Obsidian vault 同步：每10分钟拉取远端，丢弃本地改动，永远和远程保持一致
# 远端是权威源（本地 Obsidian 写入），服务器只消费不写入
# 注意：vault 仍位于 VPS /opt/data/obsidian_vault（尚未迁移到本项目）；
# 本脚本仅供 VPS 侧 cron 使用。
set -e

cd /opt/data/obsidian_vault || exit 1

git fetch origin main
git reset --hard origin/main
