use sea_orm_migration::prelude::*;

/// Per-song override for the display-only "swap main/translation lyric" toggle.
/// NULL means the song has no explicit choice and falls back to the global
/// setting (stored in localStorage by the frontend). A boolean value is
/// authoritative for that song.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_column("songs", "swap_translation").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::Table)
                        .add_column(
                            ColumnDef::new(Songs::SwapTranslation)
                                .boolean()
                                .null(),
                        )
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_column("songs", "swap_translation").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::SwapTranslation)
                        .drop_column(Songs::SwapTranslation)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    SwapTranslation,
}
