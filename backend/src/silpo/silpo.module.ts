import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoreContextService } from '../catalog/store-context.service';
import { SilpoOauthController } from './silpo-oauth.controller';
import { SilpoBenefitsDiscoveryController } from './silpo-benefits-discovery.controller';
import { SilpoProductController } from './silpo-product.controller';
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoBenefitsDiscoveryService } from './silpo-benefits-discovery.service';
import { SilpoOauthService } from './silpo-oauth.service';
import { SilpoProductService } from './silpo-product.service';
import { ProductAnalysisService } from '../score/product-analysis.service';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => TrackingModule)],
  controllers: [SilpoOauthController, SilpoBenefitsDiscoveryController, SilpoProductController],
  providers: [SilpoOauthService, SilpoConnectionService, SilpoProductService, SilpoBenefitsDiscoveryService, ProductAnalysisService, StoreContextService, { provide: 'STORE_CONTEXT', useExisting: StoreContextService }],
  exports: [SilpoOauthService, SilpoConnectionService, SilpoProductService, StoreContextService]
})
export class SilpoModule {}
