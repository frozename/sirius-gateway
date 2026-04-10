import { Controller, Get, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { ModelRegistryService } from '@sirius/model-registry';
import { GatewayService } from '../gateway.service';

@Controller('v1/models')
export class ModelsController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly compat: OpenAiCompatService,
    private readonly modelRegistry: ModelRegistryService,
  ) {}

  @Get()
  async listModels(@Res() res: FastifyReply) {
    try {
      const models = await this.gateway.listModels();

      // Merge with registry models for a complete list
      const registryModels = this.modelRegistry.listModels().map((m) => ({
        id: m.modelId,
        provider: m.provider,
        ownedBy: m.provider,
      }));

      // Deduplicate by id
      const seen = new Set(models.map((m) => m.id));
      for (const rm of registryModels) {
        if (!seen.has(rm.id)) {
          models.push(rm);
          seen.add(rm.id);
        }
      }

      const formatted = this.compat.formatModelList(models);
      return res.send(formatted);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return res.status(500).send(this.compat.formatError(500, message));
    }
  }

  @Get(':id')
  async getModel(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const capability = this.modelRegistry.getCapabilities(id);
      if (!capability) {
        return res.status(404).send(
          this.compat.formatError(404, `Model "${id}" not found.`, 'not_found_error', 'model_not_found'),
        );
      }

      return res.send({
        id: capability.modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: capability.provider,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return res.status(500).send(this.compat.formatError(500, message));
    }
  }
}
