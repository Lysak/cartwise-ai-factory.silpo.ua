import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SilpoOauthController } from './silpo-oauth.controller';
import { SilpoProductController } from './silpo-product.controller';
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService } from './silpo-oauth.service';
import { SilpoProductService } from './silpo-product.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [SilpoOauthController, SilpoProductController],
  providers: [SilpoOauthService, SilpoConnectionService, SilpoProductService],
  exports: [SilpoOauthService, SilpoConnectionService, SilpoProductService]
})
export class SilpoModule {}
