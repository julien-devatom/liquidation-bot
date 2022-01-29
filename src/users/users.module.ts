import { Module } from '@nestjs/common';
import { GraphService } from './graph/graph.service';
import { ContractService } from './contract/contract.service';
import { UsersService } from './users.service';
import { StorageService } from './storage/storage.service';

@Module({
  providers: [GraphService, ContractService, UsersService, StorageService],
})
export class UsersModule {}
