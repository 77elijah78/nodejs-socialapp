export const hasPermission = (permissions: string[] | undefined, permission: string) => {
  return Boolean(permissions?.includes(permission));
};