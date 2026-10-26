import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Shield, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { accessApi, type BoardMember } from "@/api/access";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Card } from "@/components/ui/card";
import { Identity } from "@/components/Identity";
import { InlineBanner } from "@/components/InlineBanner";
import { BOARD_CLAIM_PENDING_COPY } from "@/components/BoardClaimPendingBanner";
import { companyDirectoryQueryOptions, useAccountIdentity } from "@/api/companies-query";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

function boardMemberLabel(member: BoardMember) {
  return member.name || member.email || member.id;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function InstanceAccess() {
  const { userId: accountUserId, settled: accountSettled } = useAccountIdentity();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  const boardQuery = useQuery({
    queryKey: queryKeys.access.boardMembers,
    queryFn: () => accessApi.listBoardMembers(),
    enabled: usersQuery.isSuccess,
  });
  const [boardSearch, setBoardSearch] = useState("");
  const [boardActionError, setBoardActionError] = useState<string | null>(null);
  const boardCandidatesQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(boardSearch),
    queryFn: () => accessApi.searchAdminUsers(boardSearch),
    enabled: boardSearch.trim().length > 0,
  });
  const boardCandidates = useMemo(
    () => (boardCandidatesQuery.data ?? []).filter((user) => !user.isInstanceAdmin).slice(0, 8),
    [boardCandidatesQuery.data],
  );

  const invalidateBoardViews = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardMembers });
    await queryClient.invalidateQueries({ queryKey: ["access", "admin-users"] });
    if (selectedUserId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId) });
    }
  };

  const addBoardMemberMutation = useMutation({
    mutationFn: (userId: string) => accessApi.promoteInstanceAdmin(userId),
    onSuccess: async () => {
      setBoardActionError(null);
      setBoardSearch("");
      await invalidateBoardViews();
      pushToast({ title: "Board member added", tone: "success" });
    },
    onError: (error) => setBoardActionError(errorMessage(error, "Failed to add Board member.")),
  });

  const removeBoardMemberMutation = useMutation({
    mutationFn: (userId: string) => accessApi.demoteInstanceAdmin(userId),
    onSuccess: async () => {
      setBoardActionError(null);
      await invalidateBoardViews();
      pushToast({ title: "Board member removed", tone: "success" });
    },
    onError: (error) => setBoardActionError(errorMessage(error, "Failed to remove Board member.")),
  });

  const companiesQuery = useQuery({
    ...companyDirectoryQueryOptions(accountUserId),
    enabled: accountSettled && usersQuery.isSuccess,
  });
  const companies = companiesQuery.data ?? [];

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  const updateCompanyAccessMutation = useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Organization access updated", tone: "success" });
    },
  });

  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await invalidateBoardViews();
      pushToast({ title: "Instance role updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: errorMessage(error, "Failed to update instance role."), tone: "error" });
    },
  });

  if (usersQuery.isLoading || !accountSettled || (usersQuery.isSuccess && companiesQuery.isPending)) {
    return <div className="text-sm text-muted-foreground">Loading instance access…</div>;
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? "Instance admin access is required to manage users."
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : "Failed to load users.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  if (companiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">Failed to load organizations. Try again before changing access.</p>
        <Button onClick={() => void companiesQuery.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Instance Access</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which organizations they can access.
        </p>
      </div>

      <Card className="block space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">The Board</h2>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Board members administer the whole instance, can create companies, and are the fallback addressee for
          approvals that name no one. Agents can report to Board members but cannot be Board members. Company-level
          roles are managed per company.
        </p>

        {boardQuery.data?.legacySentinelHoldsAdmin ? (
          <InlineBanner tone="warning" compact title="Local placeholder still holds instance admin">
            {BOARD_CLAIM_PENDING_COPY}
          </InlineBanner>
        ) : null}

        {boardQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading the Board…</div>
        ) : boardQuery.error ? (
          <div className="text-sm text-destructive">{errorMessage(boardQuery.error, "Failed to load the Board.")}</div>
        ) : (
          <ul className="space-y-2" aria-label="Board members">
            {(boardQuery.data?.members ?? []).map((member) => {
              const isSelf = member.id === accountUserId;
              const isLastMember = (boardQuery.data?.members.length ?? 0) <= 1;
              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Identity name={boardMemberLabel(member)} avatarUrl={member.image} />
                    <span className="truncate text-sm text-muted-foreground">{member.email ?? member.id}</span>
                    {member.isOperator === true ? <Badge variant="secondary">Operator</Badge> : null}
                    {isSelf ? <Badge variant="outline">You</Badge> : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => removeBoardMemberMutation.mutate(member.id)}
                    disabled={removeBoardMemberMutation.isPending || isLastMember}
                    title={isLastMember ? "The Board must keep at least one member." : undefined}
                  >
                    <UserMinus className="h-4 w-4" />
                    Remove from Board
                  </Button>
                </li>
              );
            })}
            {boardQuery.data && boardQuery.data.members.length === 0 ? (
              <li className="text-sm text-muted-foreground">No Board members yet.</li>
            ) : null}
          </ul>
        )}

        <div className="space-y-2">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Add a Board member</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={boardSearch}
              onChange={(event) => setBoardSearch(event.target.value)}
              placeholder="Search existing users by name or email"
            />
          </label>
          {boardSearch.trim().length > 0 ? (
            boardCandidatesQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Searching…</div>
            ) : boardCandidates.length === 0 ? (
              <div className="text-sm text-muted-foreground">No matching users who are not already on the Board.</div>
            ) : (
              <ul className="space-y-2">
                {boardCandidates.map((user) => (
                  <li
                    key={user.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{user.name || user.email || user.id}</div>
                      <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => addBoardMemberMutation.mutate(user.id)}
                      disabled={addBoardMemberMutation.isPending}
                    >
                      <UserPlus className="h-4 w-4" />
                      Add to Board
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {boardActionError ? <p className="text-sm text-destructive">{boardActionError}</p> : null}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-(--gtc-34)">
        <Card className="block space-y-4 p-4">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Search users</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or email"
            />
          </label>
          <div className="space-y-2">
            {(usersQuery.data ?? []).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  user.id === selectedUserId
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.email || user.id}</div>
                    <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                  </div>
                  {user.isInstanceAdmin ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {user.activeCompanyMembershipCount} active organization memberships
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="block space-y-4 p-5">
          {!selectedUserId ? (
            <div className="text-sm text-muted-foreground">Select a user to inspect instance access.</div>
          ) : userAccessQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading user access…</div>
          ) : userAccessQuery.error ? (
            <div className="text-sm text-destructive">
              {userAccessQuery.error instanceof Error ? userAccessQuery.error.message : "Failed to load user access."}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold">
                    {selectedUser?.name || selectedUser?.email || selectedUserId}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selectedUser?.email || selectedUserId}
                  </div>
                </div>
                <Button
                  variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                  onClick={() => setAdminMutation.mutate(!(selectedUser?.isInstanceAdmin ?? false))}
                  disabled={setAdminMutation.isPending}
                >
                  {selectedUser?.isInstanceAdmin ? "Remove from Board" : "Add to Board (instance admin)"}
                </Button>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Organization access</h2>
                  <p className="text-sm text-muted-foreground">
                    Toggle organization membership for this user. New access defaults to an active operator membership.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                    >
                      <Checkbox
                        checked={selectedCompanyIds.has(company.id)}
                        onCheckedChange={(checked) => {
                          setSelectedCompanyIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(company.id);
                            else next.delete(company.id);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{company.name}</span>
                        <span className="block text-xs text-muted-foreground">{company.issuePrefix}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => updateCompanyAccessMutation.mutate()}
                    disabled={updateCompanyAccessMutation.isPending}
                  >
                    {updateCompanyAccessMutation.isPending ? "Saving…" : "Save organization access"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-semibold">Current memberships</h2>
                <div className="space-y-2">
                  {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                    <div
                      key={membership.id}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-medium">{membership.companyName || membership.companyId}</div>
                        <div className="text-muted-foreground">
                          {membership.membershipRole || "unset"} • {membership.status}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(membership.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
